import { Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import {
  BUILD_ID, COMPONENT_KINDS, NOTES_REF, REGISTRY_KEY, SOURCE_REVISION,
  type Component, type ComponentKind, type CompatibilityPolicy, type Product, type Release, type ReleaseIdentity,
} from '../domain/model.js';
import { isCanonicalVersion, isStableVersion } from '../domain/version.js';
import type { CompatibilityState } from '../compatibility/decision.js';
import { ReleaseStoreError } from './persistence-error.js';

const RELEASE_COLUMNS = `id, "componentId", version, "buildId", "sourceRevision", "notesRef", status, "registeredAt", "publishedAt", "withdrawnAt"`;
const POLICY_COLUMNS = `"componentId", "policyVersion", "minimumVersion", "createdAt"`;
/** SQLSTATEs of a value the schema refuses (check, not-null, malformed uuid). */
const REFUSED = new Set(['23514', '23502', '22P02']);

type Row = Record<string, unknown>;
const release = (r: Row): Release => ({
  id: r.id as string, componentId: r.componentId as string, version: r.version as string, buildId: (r.buildId as string | null) ?? null,
  sourceRevision: (r.sourceRevision as string | null) ?? null, notesRef: (r.notesRef as string | null) ?? null, status: r.status as Release['status'],
  registeredAt: r.registeredAt as Date, publishedAt: (r.publishedAt as Date | null) ?? null, withdrawnAt: (r.withdrawnAt as Date | null) ?? null,
});
const policy = (r: Row): CompatibilityPolicy => ({
  componentId: r.componentId as string, policyVersion: r.policyVersion as number, minimumVersion: r.minimumVersion as string, createdAt: r.createdAt as Date,
});
const sameIdentity = (a: ReleaseIdentity, b: ReleaseIdentity) =>
  a.componentId === b.componentId && a.version === b.version && a.buildId === b.buildId && a.sourceRevision === b.sourceRevision && a.notesRef === b.notesRef;

/** Maps a database refusal to a bounded code; anything else (a lost connection, a timeout) propagates unchanged. */
function refused(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === '40001') throw new ReleaseStoreError('policy_conflict');
  if (err.code === '23514' && /minimum version/.test(err.message ?? '')) throw new ReleaseStoreError('invariant_violation');
  if (err.code === '23514' && /release lifecycle/.test(err.message ?? '')) throw new ReleaseStoreError('invalid_transition');
  if (err.code === '23505') throw new ReleaseStoreError('policy_conflict'); // the unique (componentId, policyVersion): a concurrent change won
  if (err.code === '23503') throw new ReleaseStoreError('not_found');
  if (err.code !== undefined && REFUSED.has(err.code)) throw new ReleaseStoreError('invalid');
  throw e;
}

/**
 * The persistence primitives of Release Management (ADR-0051, Stage 20.2). Internal: the Stage 20.3 automation routes are their only
 * HTTP callers. Every method takes the caller's transaction client, so the audit intent is written in the SAME transaction as the change
 * (the Stage 18 rule). Every statement is parameterized. The database is the authority for every invariant (uniqueness, immutability,
 * lifecycle, append-only policy, minimum ≤ latest, SemVer shape); the checks here only refuse bad input early with a bounded code.
 */
@Injectable()
export class ReleaseStore {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Runs `fn` in one transaction (the kit's; READ COMMITTED). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.db.tx(fn);
  }

  // ─────────────────────────────────────────────────────────────── product / component

  /**
   * The product with this key, created if absent (idempotent, decided by the unique key). When a CONCURRENT transaction inserted the same
   * key, `ON CONFLICT DO NOTHING` waits for it and then returns no row; the row it committed is visible only to a NEW statement (READ
   * COMMITTED takes a snapshot per statement), so the read is a separate statement, never part of the insert.
   */
  async ensureProduct(key: string, q: Queryable = this.db): Promise<Product> {
    if (!REGISTRY_KEY.test(key)) throw new ReleaseStoreError('invalid');
    const { rows } = await q.query(`INSERT INTO product (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING id, key, "createdAt"`, [key]).catch(refused);
    const p = (rows[0] as Product | undefined) ?? (await this.findProduct(key, q));
    if (!p) throw new ReleaseStoreError('not_found');
    return p;
  }

  async findProduct(key: string, q: Queryable = this.db): Promise<Product | null> {
    if (!REGISTRY_KEY.test(key)) return null;
    const { rows } = await q.query(`SELECT id, key, "createdAt" FROM product WHERE key = $1`, [key]);
    return (rows[0] as Product | undefined) ?? null;
  }

  /** The component with this key in the product, created if absent. An existing component with ANOTHER kind is a conflict (a kind never changes). */
  async ensureComponent(productId: string, key: string, kind: ComponentKind, q: Queryable = this.db): Promise<Component> {
    if (!REGISTRY_KEY.test(key) || !(COMPONENT_KINDS as readonly string[]).includes(kind)) throw new ReleaseStoreError('invalid');
    const { rows } = await q.query(
      `INSERT INTO component ("productId", key, kind) VALUES ($1, $2, $3) ON CONFLICT ("productId", key) DO NOTHING RETURNING id, "productId", key, kind, "createdAt"`,
      [productId, key, kind],
    ).catch(refused);
    // A concurrent insert of the same component: read it in a NEW statement (see ensureProduct).
    const c = (rows[0] as Component | undefined)
      ?? ((await q.query(`SELECT id, "productId", key, kind, "createdAt" FROM component WHERE "productId" = $1 AND key = $2`, [productId, key]).catch(refused)).rows[0] as Component | undefined);
    if (!c) throw new ReleaseStoreError('not_found');
    if (c.kind !== kind) throw new ReleaseStoreError('conflict');
    return c;
  }

  async findComponent(productKey: string, componentKey: string, q: Queryable = this.db): Promise<Component | null> {
    if (!REGISTRY_KEY.test(productKey) || !REGISTRY_KEY.test(componentKey)) return null;
    const { rows } = await q.query(
      `SELECT c.id, c."productId", c.key, c.kind, c."createdAt" FROM component c JOIN product p ON p.id = c."productId" WHERE p.key = $1 AND c.key = $2`,
      [productKey, componentKey],
    );
    return (rows[0] as Component | undefined) ?? null;
  }

  // ─────────────────────────────────────────────────────────────── release

  /**
   * Registers a release once (status `registered`). Idempotent on (componentId, version): the same identity again returns the stored
   * release (`created: false`); a DIFFERENT identity for an existing version is a conflict, because a release never changes.
   */
  async registerRelease(identity: ReleaseIdentity, q: Queryable = this.db): Promise<{ release: Release; created: boolean }> {
    const valid = isCanonicalVersion(identity.version)
      && (identity.buildId === null || BUILD_ID.test(identity.buildId))
      && (identity.sourceRevision === null || SOURCE_REVISION.test(identity.sourceRevision))
      && (identity.notesRef === null || NOTES_REF.test(identity.notesRef));
    if (!valid) throw new ReleaseStoreError('invalid');
    const { rows } = await q.query(
      `INSERT INTO release ("componentId", version, "buildId", "sourceRevision", "notesRef") VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("componentId", version) DO NOTHING RETURNING ${RELEASE_COLUMNS}`,
      [identity.componentId, identity.version, identity.buildId, identity.sourceRevision, identity.notesRef],
    ).catch(refused);
    if (rows[0]) return { release: release(rows[0]), created: true };
    const existing = await this.findRelease(identity.componentId, identity.version, q);
    if (!existing) throw new ReleaseStoreError('not_found');
    if (!sameIdentity(existing, identity)) throw new ReleaseStoreError('conflict');
    return { release: existing, created: false };
  }

  async findRelease(componentId: string, version: string, q: Queryable = this.db): Promise<Release | null> {
    if (!isCanonicalVersion(version)) return null;
    const { rows } = await q.query(`SELECT ${RELEASE_COLUMNS} FROM release WHERE "componentId" = $1 AND version = $2`, [componentId, version]).catch(refused);
    return rows[0] ? release(rows[0]) : null;
  }

  /** registered → published. Already published: no change (`changed: false`). Withdrawn: `invalid_transition`. */
  async publishRelease(releaseId: string, q: Queryable = this.db): Promise<{ release: Release; changed: boolean }> {
    return this.move(releaseId, 'registered', 'published', `status = 'published', "publishedAt" = now()`, q);
  }

  /**
   * published → withdrawn. Already withdrawn: no change. Registered (never published): `invalid_transition` (ADR-0051: the lifecycle is
   * registered → published → withdrawn). A withdrawal that would leave the minimum above the latest release: `invariant_violation`.
   */
  async withdrawRelease(releaseId: string, q: Queryable = this.db): Promise<{ release: Release; changed: boolean }> {
    return this.move(releaseId, 'published', 'withdrawn', `status = 'withdrawn', "withdrawnAt" = now()`, q);
  }

  private async move(releaseId: string, from: Release['status'], to: Release['status'], set: string, q: Queryable) {
    const { rows } = await q.query(`UPDATE release SET ${set} WHERE id = $1 AND status = $2 RETURNING ${RELEASE_COLUMNS}`, [releaseId, from]).catch(refused);
    if (rows[0]) return { release: release(rows[0]), changed: true };
    const { rows: now } = await q.query(`SELECT ${RELEASE_COLUMNS} FROM release WHERE id = $1`, [releaseId]).catch(refused);
    if (!now[0]) throw new ReleaseStoreError('not_found');
    const current = release(now[0]);
    if (current.status === to) return { release: current, changed: false };
    throw new ReleaseStoreError('invalid_transition');
  }

  /**
   * Stage 20.4: takes the component's transaction-scoped advisory lock (the one the policy and withdrawal triggers take), FIRST, so a
   * policy change and a withdrawal of the same component are serialized and every read after it sees the other's committed result.
   */
  async lockComponent(componentId: string, q: Queryable): Promise<void> {
    await q.query(`SELECT release_lock_component($1)`, [componentId]).catch(refused);
  }

  /**
   * Stage 20.4: would withdrawing this published release leave the current minimum above the new latest? The same rule the
   * `release_withdrawal_keeps_minimum` trigger enforces (which stays the authority); used only to refuse early, before a step-up is spent.
   */
  async withdrawalBreaksMinimum(componentId: string, releaseId: string, q: Queryable = this.db): Promise<boolean> {
    const { rows } = await q.query(
      `SELECT EXISTS (
         SELECT 1 FROM (SELECT "minimumMajor" AS ma, "minimumMinor" AS mi, "minimumPatch" AS pa FROM compatibility_policy
                         WHERE "componentId" = $1 ORDER BY "policyVersion" DESC LIMIT 1) p
          WHERE NOT EXISTS (SELECT 1 FROM release r WHERE r."componentId" = $1 AND r.id <> $2 AND r.status = 'published' AND r.prerelease IS NULL
                              AND (r.major, r.minor, r.patch) >= (p.ma, p.mi, p.pa))) AS breaks`,
      [componentId, releaseId],
    ).catch(refused);
    return rows[0]?.breaks === true;
  }

  /**
   * Stage 20.5: everything one compatibility decision needs — the component, the exact release, the CURRENT policy (the highest version)
   * and the latest (highest published, not withdrawn, stable) — in ONE statement, so it is one snapshot of committed state (READ
   * COMMITTED takes a snapshot per statement): a withdrawal or a policy change commits either entirely before or entirely after it, and
   * every committed state satisfies the invariants. Read-only; uses the unique keys, the policy key and `release_latest_idx`.
   */
  async compatibilityState(productKey: string, componentKey: string, version: string, q: Queryable = this.db): Promise<CompatibilityState> {
    const { rows } = await q.query(
      `WITH c AS (SELECT c.id, c.kind FROM component c JOIN product p ON p.id = c."productId" WHERE p.key = $1 AND c.key = $2),
            r AS (SELECT r.id, r.status FROM release r JOIN c ON r."componentId" = c.id WHERE r.version = $3),
            pol AS (SELECT p."policyVersion", p."minimumVersion" FROM compatibility_policy p JOIN c ON p."componentId" = c.id
                     ORDER BY p."policyVersion" DESC LIMIT 1),
            lat AS (SELECT r.id, r.version FROM release r JOIN c ON r."componentId" = c.id
                     WHERE r.status = 'published' AND r.prerelease IS NULL ORDER BY r.major DESC, r.minor DESC, r.patch DESC LIMIT 1)
       SELECT c.id AS "componentId", c.kind, r.id AS "releaseId", r.status, pol."policyVersion", pol."minimumVersion", lat.id AS "latestId", lat.version AS "latestVersion"
         FROM (SELECT 1) one LEFT JOIN c ON true LEFT JOIN r ON true LEFT JOIN pol ON true LEFT JOIN lat ON true`,
      [productKey, componentKey, version],
    ).catch(refused);
    const x = rows[0] as Row;
    return {
      component: x.componentId ? { id: x.componentId as string, kind: x.kind as ComponentKind } : null,
      release: x.releaseId ? { id: x.releaseId as string, status: x.status as Release['status'] } : null,
      policy: x.policyVersion != null ? { policyVersion: Number(x.policyVersion), minimumVersion: x.minimumVersion as string } : null,
      latest: x.latestId ? { id: x.latestId as string, version: x.latestVersion as string } : null,
    };
  }

  /** "Latest" (ADR-0051 §4): the highest published, not-withdrawn release without a pre-release tag, by SemVer precedence. */
  async latestRelease(componentId: string, q: Queryable = this.db): Promise<Release | null> {
    const { rows } = await q.query(
      `SELECT ${RELEASE_COLUMNS} FROM release WHERE "componentId" = $1 AND status = 'published' AND prerelease IS NULL
       ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`,
      [componentId],
    ).catch(refused);
    return rows[0] ? release(rows[0]) : null;
  }

  // ─────────────────────────────────────────────────────────────── compatibility policy

  async currentPolicy(componentId: string, q: Queryable = this.db): Promise<CompatibilityPolicy | null> {
    const { rows } = await q.query(
      `SELECT ${POLICY_COLUMNS} FROM compatibility_policy WHERE "componentId" = $1 ORDER BY "policyVersion" DESC LIMIT 1`,
      [componentId],
    ).catch(refused);
    return rows[0] ? policy(rows[0]) : null;
  }

  /**
   * Appends the next policy of a client component. `expectedPolicyVersion` is the version the caller last saw (0 when none): a stale
   * expectation is `policy_conflict` (optimistic concurrency, Stage 20.4). A minimum above the latest release is `invariant_violation`.
   */
  async appendPolicy(componentId: string, expectedPolicyVersion: number, minimumVersion: string, q: Queryable = this.db): Promise<CompatibilityPolicy> {
    if (!Number.isSafeInteger(expectedPolicyVersion) || expectedPolicyVersion < 0 || !isStableVersion(minimumVersion)) throw new ReleaseStoreError('invalid');
    const { rows } = await q.query(
      `INSERT INTO compatibility_policy ("componentId", "policyVersion", "minimumVersion") VALUES ($1, $2, $3) RETURNING ${POLICY_COLUMNS}`,
      [componentId, expectedPolicyVersion + 1, minimumVersion],
    ).catch(refused);
    return policy(rows[0]!);
  }
}

