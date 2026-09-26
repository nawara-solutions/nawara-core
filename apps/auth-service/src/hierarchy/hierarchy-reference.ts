import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { correlationHeaders } from '@nawara/service-kit';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { authError } from '../errors.js';
import { withReferenceWrite } from './hierarchy-authority.js';

/**
 * Stage 21.C.2 (ADR-0040 decisions 1 and 2, Amendment 1 A1.2; Stage 10.0 §4.5 R2c; ADR-0042 A.3 and A.5): Auth's reference-cache protocol.
 *
 * Once Organization Service is the hierarchy authority, Auth's `company`, `platform` and `organization` tables are a NON-authoritative,
 * validated reference cache. A row is placed only by `ensure`, which fetches the entity from Organization Service (Auth's own full-read
 * credential), parents first, and inserts it through the database's reference-write gate (migration 0008). Never from a client-supplied
 * value: a client names an id, Organization Service says what it is. Anchors never change: a cached row whose anchor disagrees with the
 * authority fails closed and raises `hierarchy_anchor_mismatch` (an id was reused, or data was tampered with). Nothing is deleted, and
 * presentation snapshots (`name`, `key`) are not refreshed here (they may be stale, A1.2).
 *
 * Bounded and fail closed: Organization Service unavailable, not yet authoritative, slow, redirecting or answering something that is not its
 * answer is a 503 `hierarchy_unavailable`, and the caller writes nothing. Called only from administrative first-touch flows (join code,
 * invitation, platform assignment) and the owner bootstrap: never from login, refresh, logout, `/auth/me`, registration, join or consume.
 */
export type HierarchyKind = 'company' | 'platform' | 'organization';

/** Organization Service's answers are a few hundred bytes; anything larger is not its answer and is never buffered whole. */
export const MAX_HIERARCHY_RESPONSE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH: Record<HierarchyKind, string> = { company: 'companies', platform: 'platforms', organization: 'organizations' };

export const hierarchyUnavailable = () =>
  authError(503, 'hierarchy_unavailable', 'The organization hierarchy could not be verified; nothing was changed. Retry later.');

interface Fetched {
  company: { id: string; name: string };
  platform: { id: string; companyId: string; name: string; key: string | null };
  organization: { id: string; platformId: string; name: string };
}

/** The hardened client (the Stage 19.4 / 21.C.2 rules): a deadline, no redirect followed, a capped body read under the deadline, unread bodies released. */
export class OrganizationDirectoryClient {
  private readonly log = new Logger('OrganizationDirectory');
  constructor(private readonly opts: { baseUrl: string; token: string; timeoutMs: number }) {}

  private unavailable(reason: string) {
    this.log.warn(`hierarchy_reference_unavailable reason=${reason}`);
    return hierarchyUnavailable();
  }

  /** The entity, or null when Organization Service says it does not exist or is outside Auth's Platform scope (one collapsed 404). */
  async get<K extends HierarchyKind>(kind: K, id: string): Promise<Fetched[K] | null> {
    const deadline = AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/organization/${PATH[kind]}/${id}`, {
        headers: { authorization: `Bearer ${this.opts.token}`, accept: 'application/json', ...correlationHeaders() },
        redirect: 'manual',
        signal: deadline,
      });
    } catch {
      throw this.unavailable(deadline.aborted ? 'timeout' : 'network');
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) return null;
      if (res.status === 401 || res.status === 403) this.log.warn(`hierarchy_reference_denied status=${res.status} — Auth's credential or capability is not configured at Organization Service`);
      throw this.unavailable(res.status === 409 ? 'not_authoritative' : res.status >= 300 && res.status < 400 ? 'redirect_refused' : `status_${res.status}`);
    }
    let body: Record<string, unknown>;
    try {
      if (Number(res.headers.get('content-length') ?? 0) > MAX_HIERARCHY_RESPONSE_BYTES || !res.body) throw new Error('oversized');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_HIERARCHY_RESPONSE_BYTES) throw new Error('oversized');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch (e) {
      await res.body?.cancel().catch(() => undefined);
      throw this.unavailable(deadline.aborted ? 'timeout' : e instanceof Error && e.message === 'oversized' ? 'oversized' : 'malformed');
    }
    const str = (v: unknown) => typeof v === 'string' && v.trim() !== '';
    const uuid = (v: unknown) => typeof v === 'string' && UUID.test(v);
    if (typeof body !== 'object' || body === null || body.id !== id || !str(body.name)) throw this.unavailable('malformed');
    if (kind === 'platform' && (!uuid(body.companyId) || (body.key !== null && body.key !== undefined && typeof body.key !== 'string'))) throw this.unavailable('malformed');
    if (kind === 'organization' && !uuid(body.platformId)) throw this.unavailable('malformed');
    const out = kind === 'company'
      ? { id, name: body.name }
      : kind === 'platform'
        ? { id, companyId: body.companyId, name: body.name, key: (body.key as string | null | undefined) ?? null }
        : { id, platformId: body.platformId, name: body.name };
    return out as Fetched[K];
  }
}

export const ORGANIZATION_DIRECTORY = Symbol('ORGANIZATION_DIRECTORY');

@Injectable()
export class HierarchyReference implements OnApplicationBootstrap {
  private readonly log = new Logger('HierarchyReference');
  private readonly client?: OrganizationDirectoryClient;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(ORGANIZATION_DIRECTORY) client: OrganizationDirectoryClient | null,
  ) {
    this.client = client ?? undefined;
  }

  /**
   * The configured source and the database marker (the mirror of Organization Service's authority, migration 0008) should agree after the
   * 21.x switch. A disagreement is reported, never repaired: the database guard still refuses every non-reference hierarchy write.
   */
  onApplicationBootstrap(): void {
    // Best effort and never awaited: startup must not depend on the database (readiness reports it) nor on this check.
    void this.reportSource().catch(() => this.log.warn('auth_hierarchy_source marker=unknown — the marker could not be read at startup'));
  }

  private async reportSource(): Promise<void> {
    const { rows } = await this.db.query<{ mode: string }>('SELECT mode FROM hierarchy_authority');
    const mode = rows[0]?.mode;
    this.log.log(`auth_hierarchy_source source=${this.cfg.hierarchy.source} marker=${mode} credential=${this.client ? 'configured' : 'absent'}`);
    if ((mode === 'org_authoritative') !== this.fromOrganizationService) {
      this.log.warn(`hierarchy_source_mismatch source=${this.cfg.hierarchy.source} marker=${mode} — first touches of new entities fail closed until configuration and marker agree (ADR-0040 decision 3)`);
    }
  }

  /** Whether administrative first touches go through `ensure` (the configured source, ADR-0040 decision 3: a configuration switch). */
  get fromOrganizationService(): boolean {
    return this.cfg.hierarchy.source === 'organization-service';
  }

  /**
   * First touch of an Organization: when the source is Organization Service, places it (and its Platform and Company) if it is not cached.
   * Returns false when Organization Service says it does not exist (the caller answers its usual 404). With the local source: nothing.
   */
  async firstTouchOrganization(organizationId: string): Promise<boolean> {
    return this.fromOrganizationService ? this.ensure('organization', organizationId) : true;
  }

  async firstTouchPlatform(platformId: string): Promise<boolean> {
    return this.fromOrganizationService ? this.ensure('platform', platformId) : true;
  }

  /**
   * `ensure(id)`: true when the entity is (now) a validated reference row; false when Organization Service says it does not exist (or it
   * is outside Auth's scope there). A cached row answers locally with no call (the first touch already happened). Throws 503 when the
   * authority cannot answer, when this Auth has no Organization Service credential, or when the database refuses the reference write
   * (the hierarchy is frozen for the transition: AD-5's temporarily unavailable state).
   */
  async ensure(kind: HierarchyKind, id: string): Promise<boolean> {
    const lower = id.toLowerCase();
    if (!UUID.test(lower)) return false;
    if (await this.cached(this.db, kind, lower)) return true;
    if (!this.client) {
      this.log.warn(`hierarchy_reference_unavailable reason=no_credential kind=${kind}`);
      throw hierarchyUnavailable();
    }
    // Parents first, fetched OUTSIDE any transaction; each is placed before its child so the foreign keys hold.
    const chain: Array<{ kind: HierarchyKind; row: Fetched[HierarchyKind] }> = [];
    let next: { kind: HierarchyKind; id: string } | null = { kind, id: lower };
    while (next) {
      if (next.kind !== kind && (await this.cached(this.db, next.kind, next.id))) break;
      const row: Fetched[HierarchyKind] | null = await this.client.get(next.kind, next.id);
      if (!row) {
        if (next.kind === kind) return false;
        this.log.warn(`hierarchy_reference_unavailable reason=parent_missing kind=${next.kind}`);
        throw hierarchyUnavailable(); // a child whose parent the authority does not show: not an answer to trust
      }
      chain.unshift({ kind: next.kind, row });
      next = next.kind === 'organization' ? { kind: 'platform', id: (row as Fetched['organization']).platformId }
        : next.kind === 'platform' ? { kind: 'company', id: (row as Fetched['platform']).companyId } : null;
    }
    try {
      await this.db.tx(async (q) => {
        await withReferenceWrite(q);
        for (const { kind: k, row } of chain) await this.place(q, k, row);
      });
    } catch (e) {
      if (e instanceof Error && 'getStatus' in e) throw e;
      this.log.warn(`hierarchy_reference_unavailable reason=reference_write_refused kind=${kind}`); // e.g. frozen for the transition
      throw hierarchyUnavailable();
    }
    return true;
  }

  private async cached(q: Queryable, kind: HierarchyKind, id: string): Promise<boolean> {
    const { rowCount } = await q.query(`SELECT 1 FROM ${kind} WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Inserts one validated reference row, or verifies an existing one's anchor (a concurrent first touch placed it). Never updates. */
  private async place(q: Queryable, kind: HierarchyKind, row: Fetched[HierarchyKind]): Promise<void> {
    if (kind === 'company') {
      await q.query(`INSERT INTO company (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [row.id, row.name]);
      return;
    }
    const [anchorColumn, anchor] = kind === 'platform' ? ['companyId', (row as Fetched['platform']).companyId] : ['platformId', (row as Fetched['organization']).platformId];
    if (kind === 'platform') {
      await q.query(`INSERT INTO platform (id, "companyId", name, key) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [row.id, anchor, row.name, (row as Fetched['platform']).key]);
    } else {
      await q.query(`INSERT INTO organization (id, "platformId", name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [row.id, anchor, row.name]);
    }
    const { rows } = await q.query(`SELECT "${anchorColumn}" AS anchor FROM ${kind} WHERE id = $1`, [row.id]);
    if (rows[0]?.anchor !== anchor) {
      // ADR-0040 decision 1: an anchor that disagrees with the authority means a reused id or tampered data. Fail closed, and alert.
      this.log.error(`hierarchy_anchor_mismatch kind=${kind} id=${row.id} — the cached anchor disagrees with Organization Service; nothing was changed`);
      throw hierarchyUnavailable();
    }
  }
}
