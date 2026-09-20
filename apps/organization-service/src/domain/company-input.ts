import { LIMITS, failing, readObject, requiredText } from './input.js';

const fail = failing('invalid_company_request');

export interface CreateCompanyInput {
  name: string;
}
export interface UpdateCompanyInput {
  name?: string;
}

/** Company: only its name is a client-supplied fact. The id and timestamps are the service's. */
export function normaliseCreateCompany(raw: unknown): CreateCompanyInput {
  const body = readObject(raw, ['name'], fail);
  return { name: requiredText(body, 'name', LIMITS.name, fail) };
}

export function normaliseUpdateCompany(raw: unknown): UpdateCompanyInput {
  const body = readObject(raw, ['name'], fail, ['id', 'createdAt', 'updatedAt']);
  const out: UpdateCompanyInput = {};
  if ('name' in body) out.name = requiredText(body, 'name', LIMITS.name, fail);
  if (Object.keys(out).length === 0) throw fail('at least one field must be provided');
  return out;
}
