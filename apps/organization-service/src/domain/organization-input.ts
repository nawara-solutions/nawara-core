import { LIMITS, failing, optionalText, readObject, requiredText, requiredUuid } from './input.js';

const fail = failing('invalid_organization_request');

/** `type` is generic and opaque (ADR-0001, ADR-0020): its value is never validated against a list or given meaning by this service. */
export interface CreateOrganizationInput {
  platformId: string;
  name: string;
  taxCode: string | null;
  address: string | null;
  phone: string | null;
  type: string | null;
}
export interface UpdateOrganizationInput {
  name?: string;
  taxCode?: string | null;
  address?: string | null;
  phone?: string | null;
  type?: string | null;
}

const OPTIONAL_FIELDS = ['taxCode', 'address', 'phone', 'type'] as const;

export function normaliseCreateOrganization(raw: unknown): CreateOrganizationInput {
  const body = readObject(raw, ['platformId', 'name', ...OPTIONAL_FIELDS], fail);
  return {
    platformId: requiredUuid(body, 'platformId', fail),
    name: requiredText(body, 'name', LIMITS.name, fail),
    taxCode: optionalText(body, 'taxCode', LIMITS.taxCode, fail) ?? null,
    address: optionalText(body, 'address', LIMITS.address, fail) ?? null,
    phone: optionalText(body, 'phone', LIMITS.phone, fail) ?? null,
    type: optionalText(body, 'type', LIMITS.type, fail) ?? null,
  };
}

/** `platformId` is immutable (an organization never moves to another platform). An explicit `null` clears an optional field. */
export function normaliseUpdateOrganization(raw: unknown): UpdateOrganizationInput {
  const body = readObject(raw, ['name', ...OPTIONAL_FIELDS], fail, ['id', 'platformId', 'createdAt', 'updatedAt']);
  const out: UpdateOrganizationInput = {};
  if ('name' in body) out.name = requiredText(body, 'name', LIMITS.name, fail);
  for (const field of OPTIONAL_FIELDS) {
    const v = optionalText(body, field, LIMITS[field], fail);
    if (v !== undefined) out[field] = v;
  }
  if (Object.keys(out).length === 0) throw fail('at least one field must be provided');
  return out;
}
