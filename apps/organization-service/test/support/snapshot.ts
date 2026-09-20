import { sealSnapshot, serializeSnapshot, type SnapshotRow } from '@nawara/service-kit';
import { HIERARCHY_FORMAT } from '../../src/ownership/hierarchy-snapshot.js';

/** Fixed ids so every run builds the same bytes. */
export const ID = {
  co: 'c0000000-0000-4000-8000-000000000001',
  p1: 'a0000000-0000-4000-8000-000000000001',
  p2: 'a0000000-0000-4000-8000-000000000002',
  o1: 'b0000000-0000-4000-8000-000000000001',
  o2: 'b0000000-0000-4000-8000-000000000002',
};
const T1 = '2024-01-02T03:04:05.123456Z';
const T2 = '2024-02-03T04:05:06.654321Z';

export interface Data {
  company: SnapshotRow[];
  platform: SnapshotRow[];
  organization: SnapshotRow[];
}

export function baseData(): Data {
  return {
    company: [{ id: ID.co, name: 'Acme Holdings', createdAt: T1, updatedAt: T1 }],
    platform: [
      { id: ID.p1, companyId: ID.co, name: 'Alpha', key: 'alpha', createdAt: T1, updatedAt: T2 },
      { id: ID.p2, companyId: ID.co, name: 'Beta', key: null, createdAt: T1, updatedAt: T1 },
    ],
    organization: [
      { id: ID.o1, platformId: ID.p1, name: 'Org One', taxCode: 'TX-1', address: '1 Main St', phone: '+21611111111', type: 'school', createdAt: T1, updatedAt: T2 },
      { id: ID.o2, platformId: ID.p2, name: 'Org Two', taxCode: null, address: null, phone: null, type: null, createdAt: T1, updatedAt: T1 },
    ],
  };
}

/** A sealed snapshot, as auth-service's exporter produces it (`frozen` only when taken under the freeze). */
export function snapshot(data: Data = baseData(), frozen = false) {
  return sealSnapshot({ ...HIERARCHY_FORMAT, source: { service: 'auth-service', migrations: ['0001', '0004', '0007'] }, frozen, tables: { ...data } });
}
export const snapshotText = (data: Data = baseData(), frozen = false): string => serializeSnapshot(snapshot(data, frozen));
export const parsed = (data: Data = baseData(), frozen = false) => JSON.parse(snapshotText(data, frozen));
