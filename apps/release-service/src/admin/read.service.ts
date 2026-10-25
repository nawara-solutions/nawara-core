import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { REGISTRY_KEY, RELEASE_STATUSES, type Component, type Release } from '../domain/model.js';
import { RELEASE_MESSAGES } from '../messages.js';
import { ReleaseStore } from '../persistence/release-store.js';
import { adminError } from './admin.service.js';

/** The page size of the release and policy-history reads: 1–100, default 50 (Core's read convention). */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const LIMIT = /^[1-9]\d{0,2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const US = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProductView { product: string; components: Array<{ component: string; kind: Component['kind'] }> }
export interface ReleaseView {
  version: string;
  status: Release['status'];
  buildId: string | null;
  sourceRevision: string | null;
  notesRef: string | null;
  registeredAt: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
}
export interface ReleasePage { product: string; component: string; kind: Component['kind']; releases: ReleaseView[]; nextCursor: string | null }
export interface PolicyEntryView { policyVersion: number; minimumVersion: string; createdAt: string }
export interface PolicyHistoryPage { product: string; component: string; kind: Component['kind']; entries: PolicyEntryView[]; nextCursor: string | null }

const invalidQuery = () => adminError(400, 'validation_error', RELEASE_MESSAGES.invalidQuery);
const invalidCursor = () => adminError(400, 'invalid_cursor', RELEASE_MESSAGES.invalidCursor);

/**
 * Core V2 S2-Release.1 (register REL-01, REL-02, REL-03; ADR-0051, ADR-0050 decision 1): the owner's three READS of the release registry.
 * The guard has verified, live through Auth, that the caller is the owner of the configured operating Company (the Release registry's one
 * scope: there is no Company or Platform dimension in it); nothing here takes an identity, a Company or a scope from the request. Reads
 * never change anything, need no step-up and write no audit record. Internal identifiers (row ids) are never returned: keys are the identity.
 *
 * Pagination (releases, policy history): `limit` (1–100, default 50) and an opaque `cursor`, a keyset position bound to the exact query
 * (route, product, component, status). It carries no authority (every page passes the guard again) and is refused with `invalid_cursor`
 * when malformed or presented with another query.
 */
@Injectable()
export class ReadService {
  constructor(@Inject(ReleaseStore) private readonly store: ReleaseStore) {}

  async products(query: unknown): Promise<{ products: ProductView[] }> {
    strictQuery(query, []);
    return { products: await this.store.listProducts() };
  }

  async releases(productKey: string, componentKey: string, query: unknown): Promise<ReleasePage> {
    const q = strictQuery(query, ['limit', 'cursor', 'status']);
    const status = q.status === undefined ? undefined : (RELEASE_STATUSES as readonly string[]).includes(q.status) ? (q.status as Release['status']) : invalidStatus();
    const c = await this.component(productKey, componentKey);
    const limit = pageSize(q.limit);
    const binding = fingerprint('releases', productKey, componentKey, status ?? '');
    let after: { registeredAtUs: string; id: string } | undefined;
    if (q.cursor !== undefined) {
      const [t, i] = decodeCursor(q.cursor, binding).split(':');
      if (!t || !i || !US.test(t) || !UUID.test(i)) throw invalidCursor();
      after = { registeredAtUs: t, id: i };
    }
    const rows = await this.store.listReleases(c.id, { ...(status ? { status } : {}), ...(after ? { after } : {}), limit });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      product: productKey, component: componentKey, kind: c.kind,
      releases: page.map(({ release: r }) => ({
        version: r.version, status: r.status, buildId: r.buildId, sourceRevision: r.sourceRevision, notesRef: r.notesRef,
        registeredAt: r.registeredAt.toISOString(), publishedAt: r.publishedAt?.toISOString() ?? null, withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(`${last.registeredAtUs}:${last.release.id}`, binding) : null,
    };
  }

  async policyHistory(productKey: string, componentKey: string, query: unknown): Promise<PolicyHistoryPage> {
    const q = strictQuery(query, ['limit', 'cursor']);
    const c = await this.component(productKey, componentKey);
    if (c.kind === 'backend') throw adminError(409, 'policy_not_applicable', RELEASE_MESSAGES.backendHasNoPolicy);
    const limit = pageSize(q.limit);
    const binding = fingerprint('policy_history', productKey, componentKey, '');
    let beforeVersion: number | undefined;
    if (q.cursor !== undefined) {
      const v = decodeCursor(q.cursor, binding);
      if (!/^[1-9]\d{0,9}$/.test(v)) throw invalidCursor();
      beforeVersion = Number(v);
    }
    const rows = await this.store.policyHistory(c.id, { ...(beforeVersion !== undefined ? { beforeVersion } : {}), limit });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      product: productKey, component: componentKey, kind: c.kind,
      entries: page.map((p) => ({ policyVersion: p.policyVersion, minimumVersion: p.minimumVersion, createdAt: p.createdAt.toISOString() })),
      nextCursor: rows.length > limit && last ? encodeCursor(String(last.policyVersion), binding) : null,
    };
  }

  private async component(productKey: string, componentKey: string): Promise<Component> {
    if (!REGISTRY_KEY.test(productKey)) throw adminError(400, 'validation_error', RELEASE_MESSAGES.invalidProductOrComponentKey);
    if (!REGISTRY_KEY.test(componentKey)) throw adminError(400, 'validation_error', RELEASE_MESSAGES.invalidComponentKey);
    const c = await this.store.findComponent(productKey, componentKey);
    if (!c) throw adminError(404, 'component_not_found', RELEASE_MESSAGES.noSuchComponent);
    return c;
  }
}

function invalidStatus(): never {
  throw invalidQuery();
}

/** Only the named parameters, each given once, non-empty and bounded; anything else is a 400. */
function strictQuery(input: unknown, allowed: readonly string[]): Record<string, string> {
  if (typeof input !== 'object' || input === null) throw invalidQuery();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.includes(k) || typeof v !== 'string' || v === '' || v.length > 256) throw invalidQuery();
    out[k] = v;
  }
  return out;
}

function pageSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!LIMIT.test(raw) || Number(raw) > MAX_LIMIT) throw invalidQuery();
  return Number(raw);
}

const fingerprint = (...parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);

function encodeCursor(position: string, binding: string): string {
  return Buffer.from(JSON.stringify({ v: 1, p: position, q: binding }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string, binding: string): string {
  if (!CURSOR.test(raw)) throw invalidCursor();
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw invalidCursor();
  const o = c as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'p,q,v' || o.v !== 1 || typeof o.p !== 'string' || o.q !== binding) throw invalidCursor();
  return o.p;
}
