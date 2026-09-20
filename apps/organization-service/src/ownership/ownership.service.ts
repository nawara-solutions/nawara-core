import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { organizationError } from '../domain/errors.js';

/** ADR-0040 and the migration `0004_ownership_transition.sql`. `authoritative` is true only for ACTIVE and RETIRED. */
export const OWNERSHIP_PHASES = ['PREPARED', 'VERIFIED', 'FROZEN', 'ACTIVATABLE', 'ACTIVE', 'RETIRED'] as const;
export type OwnershipPhase = (typeof OWNERSHIP_PHASES)[number];
export type EnvironmentClass = 'existing' | 'fresh';

export interface OwnershipState {
  phase: OwnershipPhase;
  environmentClass: EnvironmentClass | null;
  authoritative: boolean;
  verifiedDigest: string | null;
  approvedBy: string | null;
  approvedReference: string | null;
  approvedAt: Date | null;
  activatedBy: string | null;
  activatedAt: Date | null;
}

export type WriteMode = 'normal' | 'bootstrap';

/**
 * Reads the ONE ownership row and enforces the application-level guard: while this service is not authoritative, hierarchy writes
 * are refused, except the bounded first-Company bootstrap of a FRESH environment (ADR-0040 A2.5). The service NEVER changes the
 * state: the runtime role has no write privilege on it, and only the operations CLI moves it. Deployment, startup, migration, a
 * health check, a connection and message consumption therefore cannot activate authority.
 */
@Injectable()
export class OwnershipService {
  constructor(private readonly db: DbService) {}

  async state(q: Queryable = this.db): Promise<OwnershipState> {
    const { rows } = await q.query<{
      phase: OwnershipPhase; environment_class: EnvironmentClass | null; authoritative: boolean; verified_digest: string | null;
      approved_by: string | null; approved_reference: string | null; approved_at: Date | null; activated_by: string | null; activated_at: Date | null;
    }>('SELECT phase, environment_class, authoritative, verified_digest, approved_by, approved_reference, approved_at, activated_by, activated_at FROM ownership_state');
    const r = rows[0];
    if (!r) throw organizationError(503, 'not_authoritative', 'The ownership state is not initialised.');
    return {
      phase: r.phase, environmentClass: r.environment_class, authoritative: r.authoritative, verifiedDigest: r.verified_digest,
      approvedBy: r.approved_by, approvedReference: r.approved_reference, approvedAt: r.approved_at, activatedBy: r.activated_by, activatedAt: r.activated_at,
    };
  }

  /**
   * Call first in every hierarchy write transaction. Refuses (409 `not_authoritative`) unless authoritative. `bootstrap` allows ONLY the
   * first-Company insert of a fresh, still PREPARED environment, and marks the transaction so the database gate agrees. No row lock
   * is taken (the runtime role cannot lock a row it cannot update); the database gate is the backstop.
   */
  async assertWritable(q: Queryable, mode: WriteMode = 'normal'): Promise<OwnershipState> {
    const st = await this.state(q);
    if (st.authoritative) return st;
    if (mode === 'bootstrap' && st.environmentClass === 'fresh' && st.phase === 'PREPARED') {
      await q.query(`SELECT set_config('nawara.write_mode', 'bootstrap', true)`);
      return st;
    }
    throw organizationError(409, 'not_authoritative', `organization-service is not authoritative yet (phase ${st.phase}): hierarchy writes are refused.`);
  }
}
