import type { HttpException } from '@nestjs/common';
import type { MessageParams, MessageTexts } from '@nawara/service-kit';
import { ORGANIZATION_MESSAGES } from '../messages.js';
import { organizationError, type OrganizationErrorCode } from './errors.js';

/**
 * Request-body validation shared by the three entities. A body is an object of allow-listed fields only: an unknown field is a
 * 400 (mass assignment), so a client can never smuggle `id`, `createdAt`, `updatedAt` or a re-parenting `companyId`/`platformId`.
 * Validation lives here, in plain functions (unit-testable), and never trusts a value beyond its shape; the database still
 * enforces every relationship (foreign keys, immutability).
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LIMITS = { name: 200, taxCode: 64, address: 500, phone: 32, type: 64 } as const;

export type Fail = (message: string | MessageTexts, params?: MessageParams) => HttpException;
export const failing = (code: OrganizationErrorCode): Fail => (message, params) => organizationError(400, code, message, params);

export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The body must be an object whose keys are all in `allowed`; `immutable` keys get an explicit message rather than "unknown". */
export function readObject(raw: unknown, allowed: readonly string[], fail: Fail, immutable: readonly string[] = []): Record<string, unknown> {
  if (!isObject(raw)) throw fail(ORGANIZATION_MESSAGES.bodyMustBeObject);
  for (const key of Object.keys(raw)) {
    if (immutable.includes(key)) throw fail(ORGANIZATION_MESSAGES.cannotBeChanged, { name: key });
    if (!allowed.includes(key)) throw fail(ORGANIZATION_MESSAGES.unknownField, { name: key }); // the property NAME only (ADR-0054 D10), never its value
  }
  return raw;
}

/** A required, non-blank string of at most `max` characters, trimmed. */
export function requiredText(raw: Record<string, unknown>, field: string, max: number, fail: Fail): string {
  const v = raw[field];
  if (typeof v !== 'string' || v.trim() === '' || v.trim().length > max) throw fail(ORGANIZATION_MESSAGES.textLength, { name: field, max });
  return v.trim();
}

/** Absent means "not provided" (undefined); an explicit null means "no value"; anything else is a non-blank string of at most `max`. */
export function optionalText(raw: Record<string, unknown>, field: string, max: number, fail: Fail): string | null | undefined {
  if (!(field in raw) || raw[field] === undefined) return undefined;
  if (raw[field] === null) return null;
  return requiredText(raw, field, max, fail);
}

export function requiredUuid(raw: Record<string, unknown>, field: string, fail: Fail): string {
  const v = raw[field];
  if (typeof v !== 'string' || !UUID.test(v)) throw fail(ORGANIZATION_MESSAGES.mustBeUuid, { name: field });
  return v.toLowerCase();
}
