import { HttpException, UnauthorizedException } from '@nestjs/common';
import { correlationHeaders } from '@nawara/service-kit';
import { paymentError } from '../errors.js';
import { PAYMENT_MESSAGES } from '../messages.js';

/** DI token of the Owner check of the dispute routes (Core V2 S6e-D). */
export const OWNER_COMPANY_AUTHORITY = Symbol('PAYMENT_OWNER_COMPANY_AUTHORITY');

/** What Auth verified, live, for this request: the Owner and THEIR Company (never a request value). */
export interface VerifiedOwner {
  userId: string;
  companyId: string;
}

/**
 * Core V2 S6e-D (register PAY-09 to PAY-11; the Owner's R6E-3): `GET /auth/grants` with the human's OWN bearer (never a service credential),
 * the route Billing, Audit and Release already use: whether the caller is an Owner now, and their (one, immutable) Company. `null` for a
 * member or an operator; 401 when Auth refuses the bearer; 503 `owner_authority_unavailable` when Auth cannot say (nothing is inferred).
 */
export interface OwnerCompanyAuthority {
  owner(userBearer: string, deadline: AbortSignal): Promise<VerifiedOwner | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 16 * 1024;

export const ownerAuthorityUnavailable = (): HttpException => paymentError(503, 'owner_authority_unavailable', PAYMENT_MESSAGES.ownerAuthorityUnavailable);

export class HttpOwnerCompanyAuthority implements OwnerCompanyAuthority {
  constructor(private readonly opts: { baseUrl: string }) {}

  async owner(userBearer: string, deadline: AbortSignal): Promise<VerifiedOwner | null> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/auth/grants`, {
        headers: { authorization: `Bearer ${userBearer}`, accept: 'application/json', ...correlationHeaders() }, redirect: 'manual', signal: deadline,
      });
    } catch {
      throw ownerAuthorityUnavailable();
    }
    if (res.status === 401) throw new UnauthorizedException();
    if (res.status !== 200) throw ownerAuthorityUnavailable();
    let g: { userId?: unknown; kind?: unknown; companyId?: unknown };
    try {
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('oversized');
      g = JSON.parse(text) as typeof g;
    } catch {
      throw ownerAuthorityUnavailable();
    }
    if (typeof g.userId !== 'string' || !UUID.test(g.userId) || (g.kind !== 'owner' && g.kind !== 'operator' && g.kind !== 'member')) throw ownerAuthorityUnavailable();
    if (g.kind !== 'owner') return null;
    if (typeof g.companyId !== 'string' || !UUID.test(g.companyId)) throw ownerAuthorityUnavailable(); // an Owner always has a Company
    return { userId: g.userId.toLowerCase(), companyId: g.companyId.toLowerCase() };
  }
}
