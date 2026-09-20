import { describe, expect, it } from 'vitest';
import { normaliseCreateCompany, normaliseUpdateCompany } from './company-input.js';
import { normaliseCreateOrganization, normaliseUpdateOrganization } from './organization-input.js';
import { normaliseCreatePlatform, normaliseUpdatePlatform } from './platform-input.js';

const ID = '3f2b8c1e-0a4d-4b7e-9c11-2d5e6f7a8b90';
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { getResponse(): { code: string; message: string } }).getResponse();
  }
  throw new Error('expected a 400');
};

describe('company input', () => {
  it('accepts a name, trimmed', () => expect(normaliseCreateCompany({ name: ' Acme ' })).toEqual({ name: 'Acme' }));
  it.each([undefined, null, [], 'x', 3, {}, { name: '' }, { name: ' ' }, { name: 1 }, { name: 'a'.repeat(201) }, { name: 'a', extra: 1 }])('refuses %j', (raw) => {
    expect(codeOf(() => normaliseCreateCompany(raw)).code).toBe('invalid_company_request');
  });
  it('an update needs at least one field and refuses immutable ones by name', () => {
    expect(normaliseUpdateCompany({ name: 'N' })).toEqual({ name: 'N' });
    expect(codeOf(() => normaliseUpdateCompany({})).message).toMatch(/at least one/);
    for (const f of ['id', 'createdAt', 'updatedAt']) expect(codeOf(() => normaliseUpdateCompany({ [f]: 'x' })).message).toBe(`${f} cannot be changed`);
  });
});

describe('platform input', () => {
  it('accepts a company id (canonicalised to lower case) and a name', () => {
    expect(normaliseCreatePlatform({ companyId: ID.toUpperCase(), name: 'P' })).toEqual({ companyId: ID, name: 'P' });
  });
  it.each([{ name: 'P' }, { companyId: 'x', name: 'P' }, { companyId: ID }, { companyId: ID, name: '' }, { companyId: ID, name: 'P', id: ID }, { companyId: ID, name: 'P', platformId: ID }])('refuses %j', (raw) => {
    expect(codeOf(() => normaliseCreatePlatform(raw)).code).toBe('invalid_platform_request');
  });
  it('companyId is immutable, and says so', () => {
    expect(codeOf(() => normaliseUpdatePlatform({ companyId: ID })).message).toBe('companyId cannot be changed');
    expect(codeOf(() => normaliseUpdatePlatform({ name: 'x', companyId: ID })).message).toBe('companyId cannot be changed');
    expect(normaliseUpdatePlatform({ name: 'x' })).toEqual({ name: 'x' });
  });
});

describe('organization input', () => {
  it('defaults every optional field to null, and treats `type` as an opaque string', () => {
    expect(normaliseCreateOrganization({ platformId: ID, name: 'O' })).toEqual({ platformId: ID, name: 'O', taxCode: null, address: null, phone: null, type: null });
    expect(normaliseCreateOrganization({ platformId: ID, name: 'O', type: 'literally anything' }).type).toBe('literally anything');
  });
  it('accepts explicit nulls for optional fields but never for the required ones', () => {
    expect(normaliseCreateOrganization({ platformId: ID, name: 'O', taxCode: null, phone: null }).taxCode).toBeNull();
    expect(codeOf(() => normaliseCreateOrganization({ platformId: ID, name: null })).code).toBe('invalid_organization_request');
    expect(codeOf(() => normaliseCreateOrganization({ platformId: null, name: 'O' })).code).toBe('invalid_organization_request');
  });
  it.each([
    { name: 'O' }, { platformId: ID }, { platformId: ID, name: 'O', taxCode: 1 }, { platformId: ID, name: 'O', address: '' },
    { platformId: ID, name: 'O', phone: 'p'.repeat(33) }, { platformId: ID, name: 'O', type: 't'.repeat(65) },
    { platformId: ID, name: 'O', companyId: ID }, { platformId: ID, name: 'O', status: 'active' }, { platformId: ID, name: 'O', id: ID },
  ])('refuses %j', (raw) => {
    expect(codeOf(() => normaliseCreateOrganization(raw)).code).toBe('invalid_organization_request');
  });
  it('an update distinguishes "not provided" from "set to null"; platformId is immutable', () => {
    expect(normaliseUpdateOrganization({ address: null })).toEqual({ address: null });
    expect(normaliseUpdateOrganization({ name: 'N', type: 'T' })).toEqual({ name: 'N', type: 'T' });
    expect(codeOf(() => normaliseUpdateOrganization({})).message).toMatch(/at least one/);
    expect(codeOf(() => normaliseUpdateOrganization({ platformId: ID })).message).toBe('platformId cannot be changed');
    expect(codeOf(() => normaliseUpdateOrganization({ name: null })).code).toBe('invalid_organization_request');
  });
});
