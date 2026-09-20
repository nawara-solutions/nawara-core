import { LIMITS, failing, readObject, requiredText, requiredUuid } from './input.js';

const fail = failing('invalid_platform_request');

export interface CreatePlatformInput {
  companyId: string;
  name: string;
}
export interface UpdatePlatformInput {
  name?: string;
}

/** Platform: belongs to exactly one Company, named at creation and never changed afterwards. */
export function normaliseCreatePlatform(raw: unknown): CreatePlatformInput {
  const body = readObject(raw, ['companyId', 'name'], fail);
  return { companyId: requiredUuid(body, 'companyId', fail), name: requiredText(body, 'name', LIMITS.name, fail) };
}

/** `companyId` is immutable (a platform never moves to another company), so it is refused with its own message. */
export function normaliseUpdatePlatform(raw: unknown): UpdatePlatformInput {
  const body = readObject(raw, ['name'], fail, ['id', 'companyId', 'createdAt', 'updatedAt']);
  const out: UpdatePlatformInput = {};
  if ('name' in body) out.name = requiredText(body, 'name', LIMITS.name, fail);
  if (Object.keys(out).length === 0) throw fail('at least one field must be provided');
  return out;
}
