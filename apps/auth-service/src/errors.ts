import { Catch, type HttpException } from '@nestjs/common';
import { KitExceptionFilter, httpError, type JsonLogger, type MessageParams, type MessageTexts } from '@nawara/service-kit';

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
  | 'recovery_not_available'
  | 'hierarchy_unavailable';

/**
 * An Auth API error: `{ message, code }`. `message` is an `AUTH_MESSAGES` entry (rendered in en / fr / ar by the filter, English by
 * default, ADR-0054 R5) or a plain English string; `code` never changes with the language.
 */
export function authError(status: number, code: AuthErrorCode, message: string | MessageTexts, params?: MessageParams): HttpException {
  return httpError(status, code, message, params);
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

const STANDARD_FIELDS = new Set(['statusCode', 'message', 'error', 'code', 'requestId']);

/**
 * The kit's `KitExceptionFilter` with ADR-0054 localization on (Core V1 refactor R5): the same `{statusCode, message, error, code?,
 * requestId}` shape, the same opaque-500 handling, `message` rendered in the negotiated language, `Content-Language` / `Vary` on error
 * responses. One narrow Auth addition: any EXTRA field already present on an `HttpException`'s own response object passes through
 * unchanged, after `code` and before `requestId`. Today that is exactly one site (`auth.service.ts`'s `reason: 'session_ceiling_reached'`
 * on the refresh-session-ceiling 401), kept for wire compatibility rather than folded into `code` alone, since an existing client may
 * already read it. It is a machine value and is never translated.
 */
@Catch()
export class AuthExceptionFilter extends KitExceptionFilter {
  constructor(authLogger: JsonLogger) {
    super(authLogger, { localize: true });
  }

  protected override extraResponseFields(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => !STANDARD_FIELDS.has(k)));
  }
}
