import type { HttpException } from '@nestjs/common';
import { httpError, type MessageParams, type MessageTexts } from '@nawara/service-kit';
import { ORGANIZATION_MESSAGES } from '../messages.js';

/** Stable, machine-readable error codes, carried in the kit's additive `code` field of the error body. */
export type OrganizationErrorCode =
  | 'invalid_company_request'
  | 'invalid_platform_request'
  | 'invalid_organization_request'
  | 'invalid_query'
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  | 'company_not_found'
  | 'platform_not_found'
  | 'not_authoritative'
  | 'ownership_transition_rejected'
  | 'not_found'
  | 'admin_forbidden'
  | 'step_up_required';

/** `message` is an `ORGANIZATION_MESSAGES` entry (rendered in en / fr / ar, ADR-0054) or a plain English string; `code` never changes with the language. */
export function organizationError(status: number, code: OrganizationErrorCode, message: string | MessageTexts, params?: MessageParams): HttpException {
  return httpError(status, code, message, params);
}

export const notFound = (): HttpException => organizationError(404, 'not_found', ORGANIZATION_MESSAGES.notFound);
