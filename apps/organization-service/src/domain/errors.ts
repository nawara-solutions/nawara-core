import { HttpException } from '@nestjs/common';

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
  | 'not_found';

export function organizationError(status: number, code: OrganizationErrorCode, message: string): HttpException {
  return new HttpException({ message, code }, status);
}

export const notFound = (): HttpException => organizationError(404, 'not_found', 'Not found.');
