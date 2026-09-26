import { HttpException, UnauthorizedException } from '@nestjs/common';
import { correlationHeaders } from '@nawara/service-kit';

/** DI token of the Auth port owner administration uses (Stage 20.4). */
export const OWNER_AUTHORITY = Symbol('OWNER_AUTHORITY');

/** The Release Management step-up purposes (Auth's allow-list, factor only). One per operation: a proof for one never serves the other. */
export type ReleaseStepUpPurpose = 'release.withdraw' | 'compatibility_policy.change';

/**
 * Stage 20.4 (ADR-0051 decision 8, ADR-0050 decision 1): the ONLY place release-service calls another service. It forwards the human's OWN
 * bearer to Auth and nothing else: never a service credential, never a value the request supplied beyond the step-up proof, which Auth
 * alone verifies. Auth answers from live state (account active, session active, token tier = database kind), so a blocked owner or a
 * revoked session takes effect on the next request. Anything Auth cannot answer, or answers in an unexpected shape, is a 503: the
 * administration fails closed and changes nothing.
 */
export interface OwnerAuthority {
  /**
   * The verified user id of the OWNER of `operatingCompanyId`. 401 when Auth refuses the bearer; 403 `operation_not_allowed` for a member,
   * an operator or the owner of another Company (one answer); 503 (`auth_timeout` / `auth_unavailable`) when Auth cannot say.
   */
  verifyOperatingOwner(userBearer: string, operatingCompanyId: string, deadline: AbortSignal): Promise<string>;
  /**
   * Verifies AND CONSUMES the step-up through Auth (`POST /auth/step-up/verify`: single use, bound to this owner, this session, this purpose,
   * unexpired). True when consumed; false when Auth refuses the proof. 401 when the session ended meanwhile; 503 when Auth cannot say.
   */
  consumeStepUp(userBearer: string, purpose: ReleaseStepUpPurpose, stepUpToken: string, deadline: AbortSignal): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Stage 19.4 bound: Auth's answers are a few hundred bytes; anything larger is not Auth's answer (and is never buffered whole). */
export const MAX_AUTH_RESPONSE_BYTES = 16 * 1024;

/**
 * Auth could not answer, so the administration fails closed (503). `auth_timeout`: the request's Auth budget ran out; `auth_unavailable`:
 * every other failure (refused or reset connection, DNS, an unexpected status or redirect, a malformed or oversized answer). The body
 * names the class only, never Auth's address or answer.
 */
export class AuthDependencyError extends HttpException {
  constructor(readonly failure: 'auth_timeout' | 'auth_unavailable') {
    super({ message: 'Authority could not be verified; nothing was changed.', code: failure }, 503);
  }
}

export const notTheOperatingOwner = () =>
  new HttpException({ message: 'Only the owner of the operating Company may administer releases.', code: 'operation_not_allowed' }, 403);

export class HttpOwnerAuthority implements OwnerAuthority {
  constructor(private readonly opts: { baseUrl: string }) {}

  private failure(signal: AbortSignal): AuthDependencyError {
    return new AuthDependencyError(signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? 'auth_timeout' : 'auth_unavailable');
  }

  private async send(method: 'GET' | 'POST', path: string, userBearer: string, deadline: AbortSignal, body?: unknown): Promise<Response> {
    try {
      // Never follow a redirect (Stage 19.4): the bearer goes to the configured Auth and nowhere else; a 3xx is refused like any other
      // unexpected status.
      return await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${userBearer}`, ...correlationHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: deadline,
      });
    } catch {
      throw this.failure(deadline); // network error or deadline: fail CLOSED
    }
  }

  /** An answer that is not read (a refusal, an unexpected status) is released at once, so its socket returns to the pool (Stage 19.5). */
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

  async verifyOperatingOwner(userBearer: string, operatingCompanyId: string, deadline: AbortSignal): Promise<string> {
    const res = await this.send('GET', '/auth/grants', userBearer, deadline);
    if (res.status !== 200) {
      await this.release(res);
      if (res.status === 401) throw new UnauthorizedException();
      throw new AuthDependencyError('auth_unavailable');
    }
    const b = await this.json(res, deadline);
    if (typeof b.userId !== 'string' || !UUID.test(b.userId) || (b.kind !== 'owner' && b.kind !== 'operator' && b.kind !== 'member')) throw new AuthDependencyError('auth_unavailable');
    if (b.kind !== 'owner') throw notTheOperatingOwner();
    if (typeof b.companyId !== 'string' || !UUID.test(b.companyId)) throw new AuthDependencyError('auth_unavailable'); // an owner always has a Company
    if (b.companyId.toLowerCase() !== operatingCompanyId) throw notTheOperatingOwner(); // the owner of ANOTHER Company: the same answer
    return b.userId.toLowerCase();
  }

  async consumeStepUp(userBearer: string, purpose: ReleaseStepUpPurpose, stepUpToken: string, deadline: AbortSignal): Promise<boolean> {
    const res = await this.send('POST', '/auth/step-up/verify', userBearer, deadline, { purpose, stepUpToken });
    await this.release(res); // 204 has no body; a refusal's body is not needed
    if (res.status === 204) return true;
    if (res.status === 403) return false;
    if (res.status === 401) throw new UnauthorizedException();
    throw new AuthDependencyError('auth_unavailable'); // 3xx, 200, 400, 5xx…: not Auth's answer to this question
  }
}
