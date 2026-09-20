import type { CompanyRow } from '../companies/company.repository.js';
import type { OrganizationRow } from '../organizations/organization.repository.js';
import type { PlatformRow } from '../platforms/platform.repository.js';
import type { Page } from './pagination.js';

/** Response shapes are picked field by field: nothing the database adds later (and the internal `cursorAt`) leaks by accident. */
export const representCompany = (r: CompanyRow) => ({ id: r.id, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt });

export const representPlatform = (r: PlatformRow) => ({ id: r.id, companyId: r.companyId, name: r.name, key: r.key, createdAt: r.createdAt, updatedAt: r.updatedAt });

export const representOrganization = (r: OrganizationRow) => ({
  id: r.id, platformId: r.platformId, name: r.name, taxCode: r.taxCode, address: r.address, phone: r.phone, type: r.type,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export const representPage = <R extends { id: string; cursorAt: string }, T>(page: Page<R>, represent: (r: R) => T): Page<T> => ({
  items: page.items.map(represent),
  nextCursor: page.nextCursor,
});
