import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { KitExceptionFilter, getRequestContext, type JsonLogger } from '@nawara/service-kit';

/**
 * The stable, machine-readable error codes Auth's API carries in the kit's additive `code` field
 * (`KitExceptionFilter`'s `ErrorBody`, Stage 13.2). Adding `code` never changes `statusCode` or `message`:
 * every existing response shape is preserved, `code` is purely additive.
 */
export type AuthErrorCode =
  | 'validation_error'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'invalid_credentials'
  | 'invalid_refresh_token'
  | 'invalid_token'
  | 'session_expired'
  | 'session_ceiling_reached'
  | 'registration_refused'
  | 'account_already_exists'
  | 'membership_conflict'
  | 'membership_already_decided'
  | 'membership_not_active'
  | 'contact_not_verified'
  | 'contact_code_invalid'
  | 'join_code_invalid'
  | 'invitation_invalid'
  | 'invitation_not_acceptable'
  | 'operator_code_invalid'
  | 'verification_failed'
  | 'factor_already_enrolled'
  | 'factor_already_registered'
  | 'factor_unavailable'
  | 'factor_required'
  | 'step_up_unsupported'
  | 'step_up_required'
  | 'assignment_conflict'
  | 'recovery_failed'
  | 'recovery_not_available';

export function authError(status: number, code: AuthErrorCode, message: string): HttpException {
  return new HttpException({ message, code }, status);
}

/** The caller has no relation to the resource, or it does not exist: collapsed so existence is never leaked. */
export function notFound(): HttpException {
  return authError(404, 'not_found', 'Not Found');
}

/** Bare, generic 401: bad/missing bearer, inactive user, inactive session — no distinction is leaked. */
export function unauthenticated(): HttpException {
  return authError(401, 'unauthenticated', 'Unauthorized');
}

/** Bare, generic 403: the caller is authenticated but this identity kind may not use this route. */
export function forbidden(): HttpException {
  return authError(403, 'forbidden', 'Forbidden');
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large',
  422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

function codeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const code = (raw as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Identical to the kit's `KitExceptionFilter` (same `{statusCode, message, error, code?, requestId}` shape,
 * same opaque-500 handling for anything that is not an `HttpException`), with one narrow addition: any EXTRA
 * fields already present on an `HttpException`'s own response object pass through unchanged. The kit filter
 * reconstructs a fixed field set and would otherwise silently drop them — today that is exactly one site
 * (`auth.service.ts`'s `reason: 'session_ceiling_reached'` on the refresh-session-ceiling 401), kept for
 * wire compatibility rather than folded into `code` alone, since an existing client may already read it.
 */
@Catch()
export class AuthExceptionFilter extends KitExceptionFilter {
  constructor(private readonly authLogger: JsonLogger) {
    super(authLogger);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException)) return super.catch(exception, host);
    const raw = exception.getResponse();
    const extra = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => !['statusCode', 'message', 'error', 'code', 'requestId'].includes(k)))
      : {};
    if (Object.keys(extra).length === 0) return super.catch(exception, host);

    const res = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const message = typeof raw === 'string' ? raw : ((raw as { message?: string | string[] }).message ?? exception.message);
    const code = codeOf(raw);
    const requestId = getRequestContext()?.requestId;
    const body = { statusCode: status, message, error: STATUS_TEXT[status] ?? 'Error', ...(code ? { code } : {}), ...extra, requestId };
    if (status >= 500) this.authLogger.error('request failed', { status, error: exception.constructor.name });
    if (!res.headersSent) res.status(status).json(body);
  }
}
