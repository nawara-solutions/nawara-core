import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { correlationHeaders } from '@nawara/service-kit';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { authError } from '../errors.js';
import { withReferenceWrite } from './hierarchy-authority.js';
import { AUTH_MESSAGES } from '../messages.js';

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
  authError(503, 'hierarchy_unavailable', AUTH_MESSAGES.hierarchyUnavailable);

interface Fetched {
  company: { id: string; name: string };
  platform: { id: string; companyId: string; name: string; key: string | null };
  organization: { id: string; platformId: string; name: string };
}

/** Rows fetched from Organization Service for one `ensure`, in placement order: parents first, the target last. */
type ReferenceChain = Array<{ kind: HierarchyKind; row: Fetched[HierarchyKind] }>;

/** What a repair may target (ADR-0061 §3): a Company is placed only as the parent of a repaired Platform. */
export type RepairableKind = 'platform' | 'organization';
/** Why a repair could not be completed (A5.4-A3 design §8.2). An infrastructure failure: nothing was placed. */
export type ReferenceRepairFailure =
  | 'authority_unavailable' | 'authority_timeout' | 'authority_redirect' | 'authority_response_invalid'
  | 'credential_missing' | 'credential_refused' | 'parent_missing' | 'placement_refused' | 'audit_intent_unwritable';
/**
 * The two decisions `repairReference` leaves to its caller (A5.4-A3 O4). `authorize` is called once the Company of the target is known
 * and BEFORE anything is placed; `false` places nothing. `record` runs INSIDE the placement transaction, after the rows are placed (or
 * in a transaction of its own when nothing needs placing): the caller writes its success record there, and if it throws, everything
 * rolls back. This module writes no audit record of its own.
 */
export interface ReferenceRepairSteps {
  authorize(companyId: string): boolean | Promise<boolean>;
  record(q: Queryable, result: { placed: boolean }): Promise<void>;
}
/**
 * `repaired`: the target is (now) a validated reference row; `placed` says whether THIS call inserted the target's row.
 * `unresolved`: Organization Service does not show the target (or it is outside Auth's scope there), or the caller did not authorize
 * its Company: one answer, so the caller cannot tell them apart by accident. Nothing was placed.
 * `failed`: an infrastructure failure, nothing placed. `anchor_mismatch`: a cached parent link disagrees with the authority, nothing
 * placed and nothing overwritten; `at` is the entity whose cached link disagreed.
 */
export type ReferenceRepairResult =
  | { outcome: 'repaired'; placed: boolean }
  | { outcome: 'unresolved' }
  | { outcome: 'failed'; reason: ReferenceRepairFailure }
  | { outcome: 'anchor_mismatch'; at: { kind: RepairableKind; id: string } };

/**
 * Why a `503 hierarchy_unavailable` was raised, kept beside the exception and never on it: the exception, its status, its code and the
 * log lines of `ensure` are exactly what they were. Readable only inside this module, by the repair path (A5.4-A3 O6).
 */
type UnavailableCause = { reason: ReferenceRepairFailure } | { mismatch: { kind: RepairableKind; id: string } };
const CAUSES = new WeakMap<object, UnavailableCause>();
function because<E extends object>(error: E, cause: UnavailableCause): E {
  CAUSES.set(error, cause);
  return error;
}
/** The client's own failure words (they stay in its log line) as repair failure reasons. */
function clientFailure(reason: string): ReferenceRepairFailure {
  if (reason === 'timeout') return 'authority_timeout';
  if (reason === 'redirect_refused') return 'authority_redirect';
  if (reason === 'oversized' || reason === 'malformed') return 'authority_response_invalid';
  if (reason === 'status_401' || reason === 'status_403') return 'credential_refused';
  return 'authority_unavailable'; // network, not_authoritative, any other status
}

/** The hardened client (the Stage 19.4 / 21.C.2 rules): a deadline, no redirect followed, a capped body read under the deadline, unread bodies released. */
export class OrganizationDirectoryClient {
  private readonly log = new Logger('OrganizationDirectory');
  constructor(private readonly opts: { baseUrl: string; token: string; timeoutMs: number }) {}

  private unavailable(reason: string) {
    this.log.warn(`hierarchy_reference_unavailable reason=${reason}`);
    return because(hierarchyUnavailable(), { reason: clientFailure(reason) });
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
    const chain = await this.resolve(this.client, kind, lower);
    if (!chain) return false;
    await this.placeChain(chain);
    return true;
  }

  /**
   * The resolve step (A5.4-A2; ADR-0061 §4): fetches the target and each parent Auth does not hold from Organization Service, OUTSIDE any
   * transaction, stopping at the first ancestor already cached. Reads only: it writes nothing. Returns the rows parents first (the target
   * last, so the chain is never empty), or null when Organization Service does not know the target.
   */
  private async resolve(client: OrganizationDirectoryClient, kind: HierarchyKind, id: string): Promise<ReferenceChain | null> {
    // Parents first, fetched OUTSIDE any transaction; each is placed before its child so the foreign keys hold.
    const chain: ReferenceChain = [];
    let next: { kind: HierarchyKind; id: string } | null = { kind, id };
    while (next) {
      if (next.kind !== kind && (await this.cached(this.db, next.kind, next.id))) break;
      const row: Fetched[HierarchyKind] | null = await client.get(next.kind, next.id);
      if (!row) {
        if (next.kind === kind) return null;
        this.log.warn(`hierarchy_reference_unavailable reason=parent_missing kind=${next.kind}`);
        throw because(hierarchyUnavailable(), { reason: 'parent_missing' }); // a child whose parent the authority does not show: not an answer to trust
      }
      chain.unshift({ kind: next.kind, row });
      next = next.kind === 'organization' ? { kind: 'platform', id: (row as Fetched['organization']).platformId }
        : next.kind === 'platform' ? { kind: 'company', id: (row as Fetched['platform']).companyId } : null;
    }
    return chain;
  }

  /**
   * The place step (A5.4-A2; ADR-0061 §4): the resolved rows, parents first, in ONE transaction through the reference-write gate.
   * The chain's last row is the target `ensure` was asked for: its kind names a refused write, whatever row the database refused.
   */
  private async placeChain(chain: ReferenceChain): Promise<void> {
    const target = chain[chain.length - 1]!.kind;
    try {
      await this.db.tx(async (q) => {
        await withReferenceWrite(q);
        for (const { kind: k, row } of chain) await this.place(q, k, row);
      });
    } catch (e) {
      if (e instanceof Error && 'getStatus' in e) throw e;
      this.log.warn(`hierarchy_reference_unavailable reason=reference_write_refused kind=${target}`); // e.g. frozen for the transition
      throw hierarchyUnavailable();
    }
  }

  private async cached(q: Queryable, kind: HierarchyKind, id: string): Promise<boolean> {
    const { rowCount } = await q.query(`SELECT 1 FROM ${kind} WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Inserts one validated reference row, or verifies an existing one's anchor (a concurrent first touch placed it). Never updates.
   * Returns whether THIS statement inserted the row (the database's own answer), which only the repair path reads.
   */
  private async place(q: Queryable, kind: HierarchyKind, row: Fetched[HierarchyKind]): Promise<boolean> {
    if (kind === 'company') {
      const inserted = await q.query(`INSERT INTO company (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [row.id, row.name]);
      return (inserted.rowCount ?? 0) > 0;
    }
    const [anchorColumn, anchor] = kind === 'platform' ? ['companyId', (row as Fetched['platform']).companyId] : ['platformId', (row as Fetched['organization']).platformId];
    const inserted = kind === 'platform'
      ? await q.query(`INSERT INTO platform (id, "companyId", name, key) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [row.id, anchor, row.name, (row as Fetched['platform']).key])
      : await q.query(`INSERT INTO organization (id, "platformId", name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [row.id, anchor, row.name]);
    const { rows } = await q.query(`SELECT "${anchorColumn}" AS anchor FROM ${kind} WHERE id = $1`, [row.id]);
    if (rows[0]?.anchor !== anchor) {
      // ADR-0040 decision 1: an anchor that disagrees with the authority means a reused id or tampered data. Fail closed, and alert.
      this.log.error(`hierarchy_anchor_mismatch kind=${kind} id=${row.id} — the cached anchor disagrees with Organization Service; nothing was changed`);
      throw because(hierarchyUnavailable(), { mismatch: { kind, id: row.id } });
    }
    return (inserted.rowCount ?? 0) > 0;
  }

  /**
   * The repair entry (ADR-0061 §4 steps 4 to 7; A5.4-A3 O4, O5, O13): resolve without writing, let the caller authorize the Company,
   * and only then place, with the caller's success record in the SAME transaction. `resolve` and `placeChain` stay private, and this
   * method never calls `ensure`: nothing is placed before `steps.authorize` has said yes.
   *
   * It decides no HTTP answer, writes no audit record and raises no `503`: it returns what happened and the caller (the repair
   * service, A5.4-A3 slice C) maps it. Whether a repair may run at all (the configured source AND the authority marker, O15), the
   * Owner, the step-up proof and the rate limits are the caller's, BEFORE this method. As a last guard it does nothing when the
   * configured source is not Organization Service.
   *
   * A target already cached is read through its own immutable links, with no Organization Service call. For an uncached Organization
   * whose Platform is cached, that Platform is fetched too and its Company link compared with the cached one (new with the repair;
   * `ensure` keeps stopping at the first cached ancestor).
   */
  async repairReference(kind: RepairableKind, id: string, steps: ReferenceRepairSteps): Promise<ReferenceRepairResult> {
    const lower = id.toLowerCase();
    if (!this.fromOrganizationService || !UUID.test(lower)) return { outcome: 'unresolved' };

    // A cached target: its Company through its own validated links. No lookup, and nothing to place.
    const local = await this.db.query<{ company: string }>(
      kind === 'platform'
        ? `SELECT "companyId" AS company FROM platform WHERE id = $1`
        : `SELECT p."companyId" AS company FROM organization o JOIN platform p ON p.id = o."platformId" WHERE o.id = $1`,
      [lower],
    );
    if (local.rows[0]) {
      if ((await steps.authorize(local.rows[0].company)) !== true) return { outcome: 'unresolved' }; // only an explicit yes authorizes
      try {
        await this.db.tx((q) => steps.record(q, { placed: false }));
      } catch {
        return { outcome: 'failed', reason: 'audit_intent_unwritable' };
      }
      return { outcome: 'repaired', placed: false };
    }

    if (!this.client) return { outcome: 'failed', reason: 'credential_missing' };
    let chain: ReferenceChain | null;
    let companyId: string;
    try {
      chain = await this.resolve(this.client, kind, lower);
      if (!chain) return { outcome: 'unresolved' };
      const first = chain[0]!;
      if (first.kind === 'organization') {
        // Its Platform is cached (resolve stopped there): the cached Company link must be the authority's (ADR-0061 §4 step 4).
        const platformId = (first.row as Fetched['organization']).platformId;
        const authoritative = await this.client.get('platform', platformId);
        if (!authoritative) return { outcome: 'failed', reason: 'parent_missing' }; // a cached Platform the authority does not show
        const cached = await this.db.query<{ company: string }>(`SELECT "companyId" AS company FROM platform WHERE id = $1`, [platformId]);
        if (cached.rows[0]?.company !== authoritative.companyId) {
          this.log.error(`hierarchy_anchor_mismatch kind=platform id=${platformId} — the cached anchor disagrees with Organization Service; nothing was changed`);
          return { outcome: 'anchor_mismatch', at: { kind: 'platform', id: platformId } };
        }
        companyId = authoritative.companyId;
      } else {
        companyId = first.kind === 'company' ? first.row.id : (first.row as Fetched['platform']).companyId;
      }
    } catch (e) {
      return this.repairFailure(e);
    }

    if ((await steps.authorize(companyId)) !== true) return { outcome: 'unresolved' }; // only an explicit yes; nothing has been placed

    const rows = chain;
    const RECORD = Symbol('record');
    try {
      const placed = await this.db.tx(async (q) => {
        await withReferenceWrite(q);
        let target = false;
        for (const { kind: k, row } of rows) target = await this.place(q, k, row); // parents first: the last row is the target
        try {
          await steps.record(q, { placed: target });
        } catch (e) {
          throw Object.assign(new Error('the repair record could not be written'), { [RECORD]: true, cause: e });
        }
        return target;
      });
      return { outcome: 'repaired', placed };
    } catch (e) {
      if (e instanceof Error && RECORD in e) return { outcome: 'failed', reason: 'audit_intent_unwritable' };
      const known = typeof e === 'object' && e !== null ? CAUSES.get(e) : undefined;
      if (known && 'mismatch' in known) return { outcome: 'anchor_mismatch', at: known.mismatch };
      return { outcome: 'failed', reason: 'placement_refused' }; // the database refused the reference write (for example, frozen)
    }
  }

  /** A failure raised while resolving, as the repair reports it: the cause this module recorded, or the authority being unavailable. */
  private repairFailure(e: unknown): ReferenceRepairResult {
    const known = typeof e === 'object' && e !== null ? CAUSES.get(e) : undefined;
    if (known && 'mismatch' in known) return { outcome: 'anchor_mismatch', at: known.mismatch };
    if (known) return { outcome: 'failed', reason: known.reason };
    if (e instanceof Error && 'getStatus' in e) return { outcome: 'failed', reason: 'authority_unavailable' }; // a 503 with no recorded cause
    throw e; // not a hierarchy failure (for example Auth's own database): not this method's to classify
  }
}
