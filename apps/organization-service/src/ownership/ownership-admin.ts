import { canonicalJson, digestRows, type Queryable } from '@nawara/service-kit';
import {
  contentDigest, HIERARCHY_COLUMNS, HIERARCHY_TABLES, selectSql, validateHierarchySnapshot, type ValidatedSnapshot,
} from './hierarchy-snapshot.js';
import type { EnvironmentClass, OwnershipPhase } from './ownership.service.js';

/** The named, observable events of the ownership transition (Stage 10.1). Never carry a secret or a raw credential. */
export type OwnershipLogEvent =
  | 'ownership_snapshot_verified'
  | 'ownership_import_started'
  | 'ownership_import_succeeded'
  | 'ownership_import_failed'
  | 'ownership_activation_requested'
  | 'ownership_activation_succeeded'
  | 'ownership_activation_rejected'
  | 'ownership_retirement_completed'
  | 'ownership_rollback_rejected'
  | 'ownership_transition_recorded';

export class OwnershipError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export interface AdminContext {
  /** The service's NODE_ENV, recorded on every event. */
  environment: string;
  correlationId: string;
  log: (event: OwnershipLogEvent, fields: Record<string, unknown>) => void;
  /** `activate` in a production environment additionally requires this deliberate, run-time gate. */
  productionActivationEnabled?: boolean;
}

export const ACTIVATE_CONFIRMATION = 'ACTIVATE-AUTHORITY';

interface StateRow {
  phase: OwnershipPhase;
  environment_class: EnvironmentClass | null;
  verified_digest: string | null;
}

const PRE_ACTIVATION_IMPORTABLE: OwnershipPhase[] = ['PREPARED', 'VERIFIED', 'FROZEN'];

/**
 * The operations that move ownership (ADR-0040). They run with the OPERATIONS login (the schema owner / migrator), never the runtime
 * role, and are reachable only from the CLI. There is NO operation that activates authority as a side effect: `activate` needs the
 * ACTIVATABLE phase, a recorded approval, an unchanged content digest and an explicit confirmation, and in production one more gate.
 */
/** The part of the kit's `DbService` these operations use: autocommit statements, and one transaction. */
export interface AdminDb extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export class OwnershipAdmin {
  constructor(private readonly db: AdminDb, private readonly ctx: AdminContext) {}

  private async state(q: Queryable = this.db, lock = false): Promise<StateRow> {
    const { rows } = await q.query<StateRow>(`SELECT phase, environment_class, verified_digest FROM ownership_state ${lock ? 'FOR UPDATE' : ''}`);
    return rows[0]!;
  }

  private async record(p: { operation: string; actor: string; outcome: 'succeeded' | 'rejected' | 'failed'; from?: string | null; to?: string | null; digest?: string | null; detail?: object }, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO ownership_event (operation, actor, environment, correlation_id, from_phase, to_phase, snapshot_digest, outcome, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [p.operation, p.actor, this.ctx.environment, this.ctx.correlationId, p.from ?? null, p.to ?? null, p.digest ?? null, p.outcome, JSON.stringify(p.detail ?? {})],
    );
  }

  /** A rejected or failed attempt is recorded AFTER the transaction has rolled back, so the audit row survives. */
  private async reject(operation: string, actor: string, code: string, message: string, extra: { digest?: string | null; detail?: object } = {}): Promise<never> {
    const st = await this.state();
    await this.record({ operation, actor, outcome: 'rejected', from: st.phase, to: st.phase, digest: extra.digest, detail: { code, message, ...extra.detail } });
    throw new OwnershipError(code, message);
  }

  async status(): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query('SELECT phase, environment_class, authoritative, verified_digest, approved_by, approved_reference, approved_at, activated_by, activated_at FROM ownership_state');
    const counts: Record<string, number> = {};
    for (const t of HIERARCHY_TABLES) counts[t] = (await this.db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    return { ...rows[0], counts, contentDigest: await this.contentDigestNow() };
  }

  /** The digest of what this service holds right now, computed the same way the snapshot computes it. */
  async contentDigestNow(q: Queryable = this.db): Promise<string> {
    const digests: Record<string, string> = {};
    for (const t of HIERARCHY_TABLES) digests[t] = digestRows((await q.query(selectSql(t))).rows);
    return contentDigest(digests);
  }

  async declareClass(actor: string, cls: EnvironmentClass): Promise<void> {
    const st = await this.state();
    if (st.phase !== 'PREPARED' || st.environment_class !== null) return this.reject('declare-class', actor, 'class_not_declarable', `the environment class can be declared once, while PREPARED (phase ${st.phase}, class ${String(st.environment_class)})`);
    if (cls === 'existing') {
      const n = (await this.db.query('SELECT (SELECT count(*) FROM company)::int AS n')).rows[0].n;
      if (n > 0) return this.reject('declare-class', actor, 'class_conflict', 'an existing-environment transition starts from an empty preparation; this service already holds data');
    }
    await this.db.query('UPDATE ownership_state SET environment_class = $1', [cls]);
    await this.record({ operation: 'declare-class', actor, outcome: 'succeeded', from: 'PREPARED', to: 'PREPARED', detail: { environmentClass: cls } });
    this.ctx.log('ownership_transition_recorded', { operation: 'declare-class', environmentClass: cls, actor });
  }

  /** Verifies a snapshot file WITHOUT touching the database. */
  verifySnapshotText(actor: string, text: string): ValidatedSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OwnershipError('snapshot_not_json', 'the snapshot is not valid JSON');
    }
    const v = validateHierarchySnapshot(parsed);
    if (!v.ok) throw new OwnershipError('snapshot_invalid', v.errors.join('; '));
    this.ctx.log('ownership_snapshot_verified', { actor, snapshotDigest: v.value.snapshot.digests.whole, content: v.value.content, counts: v.value.snapshot.counts, frozen: v.value.snapshot.frozen });
    return v.value;
  }

  /**
   * Compare-and-insert import (ADR-0040 decision 5). Identical rows are skipped; a row that differs, or a destination row the snapshot
   * does not contain, ABORTS the whole import and leaves the state untouched; nothing is ever updated or deleted. Repeatable before activation.
   */
  async importSnapshot(actor: string, text: string): Promise<{ inserted: Record<string, number>; skipped: Record<string, number>; phase: OwnershipPhase }> {
    let v: ValidatedSnapshot;
    try {
      v = this.verifySnapshotText(actor, text);
    } catch (e) {
      const err = e as OwnershipError;
      this.ctx.log('ownership_import_failed', { actor, code: err.code });
      return this.reject('import', actor, err.code, err.message);
    }
    const digest = v.snapshot.digests.whole;
    const st0 = await this.state();
    if (st0.environment_class !== 'existing') return this.reject('import', actor, 'import_not_applicable', 'an import belongs to an existing-environment transition; declare the class "existing" first (a fresh environment has nothing to import)', { digest });
    if (!PRE_ACTIVATION_IMPORTABLE.includes(st0.phase)) return this.reject('import', actor, 'import_after_approval', `imports are refused in phase ${st0.phase}; roll back to PREPARED first`, { digest });
    if (st0.phase === 'FROZEN' && !v.snapshot.frozen) return this.reject('import', actor, 'stale_import_after_freeze', 'the environment is FROZEN: only a snapshot taken under the freeze can be imported', { digest });

    this.ctx.log('ownership_import_started', { actor, snapshotDigest: digest, frozen: v.snapshot.frozen, counts: v.snapshot.counts });
    try {
      return await this.db.tx(async (q) => {
        const st = await this.state(q, true);
        if (st.phase !== st0.phase) throw new OwnershipError('state_changed', 'the ownership state changed while the import was starting');
        await q.query(`SELECT set_config('nawara.write_mode', 'import', true)`);
        const inserted: Record<string, number> = { company: 0, platform: 0, organization: 0 };
        const skipped: Record<string, number> = { company: 0, platform: 0, organization: 0 };
        for (const t of HIERARCHY_TABLES) {
          const existing = new Map<string, Record<string, unknown>>((await q.query(selectSql(t))).rows.map((r) => [r.id as string, r]));
          const wanted = new Set(v.rows[t].map((r) => r.id as string));
          for (const id of existing.keys()) if (!wanted.has(id)) throw new OwnershipError('extra_destination_row', `${t} ${id} exists here but not in the snapshot; nothing is deleted or reconciled automatically`);
          for (const row of v.rows[t]) {
            const cur = existing.get(row.id as string);
            if (cur) {
              if (canonicalJson(cur) !== canonicalJson(row)) throw new OwnershipError('conflicting_row', `${t} ${String(row.id)} differs from the snapshot; nothing is overwritten`);
              skipped[t]!++;
              continue;
            }
            const cols = HIERARCHY_COLUMNS[t];
            const ph = cols.map((c, i) => (c === 'createdAt' || c === 'updatedAt' ? `$${i + 1}::timestamptz` : c === 'id' || c.endsWith('Id') ? `$${i + 1}::uuid` : `$${i + 1}`));
            await q.query(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ph.join(', ')})`, cols.map((c) => row[c]));
            inserted[t]!++;
          }
        }
        // Verify: this service now holds EXACTLY the snapshot.
        const now = await this.contentDigestNow(q);
        if (now !== v.content) throw new OwnershipError('digest_mismatch', 'after the import this service does not hold exactly the snapshot');
        await q.query(
          `INSERT INTO ownership_import_run (snapshot_digest, final, counts, inserted, skipped, actor, correlation_id) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)`,
          [digest, v.snapshot.frozen, JSON.stringify(v.snapshot.counts), JSON.stringify(inserted), JSON.stringify(skipped), actor, this.ctx.correlationId],
        );
        let phase = st.phase;
        if (phase === 'PREPARED') {
          await q.query(`UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = $1`, [now]);
          phase = 'VERIFIED';
        } else {
          await q.query(`UPDATE ownership_state SET verified_digest = $1`, [now]);
        }
        if (v.snapshot.frozen && phase === 'VERIFIED') {
          await q.query(`UPDATE ownership_state SET phase = 'FROZEN'`);
          phase = 'FROZEN';
        }
        await this.record({ operation: 'import', actor, outcome: 'succeeded', from: st.phase, to: phase, digest, detail: { inserted, skipped, final: v.snapshot.frozen } }, q);
        this.ctx.log('ownership_import_succeeded', { actor, snapshotDigest: digest, inserted, skipped, from: st.phase, to: phase });
        return { inserted, skipped, phase };
      });
    } catch (e) {
      const err = e instanceof OwnershipError ? e : new OwnershipError('import_failed', (e as Error).message);
      this.ctx.log('ownership_import_failed', { actor, snapshotDigest: digest, code: err.code });
      return this.reject('import', actor, err.code, err.message, { digest });
    }
  }

  /** Fresh environment (and any post-activation check): compare what this service holds with an expected content digest. */
  async verifyContent(actor: string, expected: string): Promise<{ phase: OwnershipPhase; contentDigest: string }> {
    const st = await this.state();
    const now = await this.contentDigestNow();
    if (now !== expected) {
      this.ctx.log('ownership_import_failed', { actor, code: 'verification_mismatch' });
      return this.reject('verify', actor, 'verification_mismatch', 'the content digest does not equal the expected digest', { digest: now });
    }
    let phase = st.phase;
    if (st.environment_class === 'fresh' && st.phase === 'PREPARED') {
      const n = (await this.db.query('SELECT count(*)::int AS n FROM company')).rows[0].n;
      if (n < 1) return this.reject('verify', actor, 'nothing_to_verify', 'the first Company has not been created', { digest: now });
      await this.db.query(`UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = $1`, [now]);
      phase = 'VERIFIED';
    }
    await this.record({ operation: 'verify', actor, outcome: 'succeeded', from: st.phase, to: phase, digest: now });
    this.ctx.log('ownership_snapshot_verified', { actor, content: now, phase });
    return { phase, contentDigest: now };
  }

  /** Records the explicit approval (gate G7) and makes the environment ACTIVATABLE. It does NOT activate anything. */
  async approve(actor: string, reference: string): Promise<void> {
    const st = await this.state();
    const ready = (st.environment_class === 'existing' && st.phase === 'FROZEN') || (st.environment_class === 'fresh' && st.phase === 'VERIFIED');
    if (!ready) return this.reject('approve', actor, 'not_approvable', `approval needs a FROZEN existing environment or a VERIFIED fresh one (phase ${st.phase}, class ${String(st.environment_class)})`);
    if (!reference.trim()) return this.reject('approve', actor, 'reference_required', 'the approval must cite the recorded rehearsal or approval reference');
    await this.db.query(`UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = $1, approved_reference = $2, approved_at = now()`, [actor, reference]);
    await this.record({ operation: 'approve', actor, outcome: 'succeeded', from: st.phase, to: 'ACTIVATABLE', digest: st.verified_digest, detail: { reference } });
    this.ctx.log('ownership_transition_recorded', { operation: 'approve', actor, reference, from: st.phase, to: 'ACTIVATABLE' });
  }

  /** ACTIVATE AUTHORITY: the one explicit switch (ADR-0040 A2.5). */
  async activate(actor: string, confirmation: string): Promise<void> {
    this.ctx.log('ownership_activation_requested', { actor, environment: this.ctx.environment });
    const st = await this.state();
    const refuse = async (code: string, message: string): Promise<never> => {
      this.ctx.log('ownership_activation_rejected', { actor, code });
      return this.reject('activate', actor, code, message);
    };
    if (st.phase !== 'ACTIVATABLE') return refuse('not_activatable', `authority can be activated only from ACTIVATABLE (phase ${st.phase})`);
    if (confirmation !== ACTIVATE_CONFIRMATION) return refuse('confirmation_required', `the explicit confirmation ${ACTIVATE_CONFIRMATION} is required`);
    if (this.ctx.environment === 'production' && !this.ctx.productionActivationEnabled) {
      return refuse('production_gate_closed', 'production activation is separately gated: the operator must enable it deliberately for this run, after the gates G1 to G7 of ADR-0040');
    }
    const now = await this.contentDigestNow();
    if (now !== st.verified_digest) return refuse('content_changed_since_verification', 'this service no longer holds what was verified; verify again');
    await this.db.tx(async (q) => {
      await this.state(q, true);
      await q.query(`UPDATE ownership_state SET phase = 'ACTIVE', activated_by = $1, activated_at = now()`, [actor]);
      await this.record({ operation: 'activate', actor, outcome: 'succeeded', from: 'ACTIVATABLE', to: 'ACTIVE', digest: now }, q);
    });
    this.ctx.log('ownership_activation_succeeded', { actor, from: 'ACTIVATABLE', to: 'ACTIVE', content: now });
  }

  /** Records that Auth's hierarchy writes are retired (the mirror). The evidence is the operator's attestation from Auth's own tool. */
  async retire(actor: string, evidence: string): Promise<void> {
    const st = await this.state();
    if (st.phase !== 'ACTIVE') return this.reject('retire', actor, 'not_retirable', `retirement follows activation (phase ${st.phase})`);
    if (!evidence.trim()) return this.reject('retire', actor, 'evidence_required', 'cite the evidence that Auth has retired its hierarchy writes');
    await this.db.query(`UPDATE ownership_state SET phase = 'RETIRED'`);
    await this.record({ operation: 'retire', actor, outcome: 'succeeded', from: 'ACTIVE', to: 'RETIRED', digest: st.verified_digest, detail: { evidence } });
    this.ctx.log('ownership_retirement_completed', { actor, from: 'ACTIVE', to: 'RETIRED' });
  }

  /** Rollback BEFORE activation only. After activation there is no rollback: it needs reconciliation, which is not designed. */
  async rollback(actor: string, reason: string): Promise<void> {
    const st = await this.state();
    if (st.phase === 'ACTIVE' || st.phase === 'RETIRED') {
      this.ctx.log('ownership_rollback_rejected', { actor, phase: st.phase });
      return this.reject('rollback', actor, 'rollback_after_activation', 'ownership rollback after activation is not automatic and requires reconciliation, which is not designed; a deployment rollback is not an ownership rollback');
    }
    if (st.phase === 'PREPARED') return this.reject('rollback', actor, 'nothing_to_roll_back', 'the environment is already PREPARED');
    await this.db.query(`UPDATE ownership_state SET phase = 'PREPARED'`);
    await this.record({ operation: 'rollback', actor, outcome: 'succeeded', from: st.phase, to: 'PREPARED', detail: { reason } });
    this.ctx.log('ownership_transition_recorded', { operation: 'rollback', actor, from: st.phase, to: 'PREPARED' });
  }
}
