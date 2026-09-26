import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CentralAudit, ownerActor } from '../audit/central-audit.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { notFound } from '../errors.js';
import { StepUpService } from '../owner/step-up.service.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { UsersService } from '../users/users.service.js';
import { MemberSecurityCounters } from './member-security.counters.js';

/** The closed D6 vocabulary (ADR-0050 decision 5): security metadata, never a note. Mirrors the `account.disabled` catalog entry. */
export const SUSPENSION_REASONS = ['compromised_account', 'security_incident', 'policy_violation'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export interface MemberSecurityState {
  id: string;
  suspended: boolean;
  /** false when the account was already in the requested state: nothing was written (no session revoked, no evidence). */
  changed: boolean;
}

type Owner = { userId: string; sid: string };
class NotEligible extends Error {
  constructor(readonly why: 'not_a_member' | 'not_in_company' | 'other_company') {
    super(why);
  }
}

/**
 * Stage 19.2 (ADR-0050 decision 5): an owner suspends / restores a MEMBER identity of the owner's Company.
 *
 * Everything is derived from persisted state inside ONE transaction; nothing comes from the request but the target id and the reason:
 *   1. the owner's Company, from the owner row (the guard already proved kind = owner, live);
 *   2. a FACTOR step-up for `account.suspend` / `account.restore`, consumed in this transaction (rolled back with it);
 *   3. the target user row, locked FOR UPDATE: a concurrent membership INSERT (join) needs FOR KEY SHARE on it, so a new membership is
 *      either committed before this check (and seen) or ordered after the change;
 *   4. eligibility: kind `member`, at least one ACTIVE membership in an organization of the owner's Company, and NO active or pending
 *      membership in an organization of any other Company. Suspension is global (`isActive`), so a Company-scoped authority must not
 *      deny (or restore) access under another Company;
 *   5. the state change, only if needed (state-idempotent); suspension revokes every session family; then the local security record and
 *      the central audit intent, all in the same transaction.
 * Every ineligible target (unknown id, not a member, the owner, another Company's member, a shared identity) is the same 404.
 */
@Injectable()
export class MemberSecurityService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(RefreshTokenService) private readonly refresh: RefreshTokenService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CentralAudit) private readonly central: CentralAudit,
    @Inject(MemberSecurityCounters) private readonly counters: MemberSecurityCounters,
  ) {}

  suspend(owner: Owner, memberId: string, reason: SuspensionReason, stepUpToken: string | undefined, ip: string): Promise<MemberSecurityState> {
    return this.apply(owner, memberId, true, reason, stepUpToken, ip);
  }

  restore(owner: Owner, memberId: string, stepUpToken: string | undefined, ip: string): Promise<MemberSecurityState> {
    return this.apply(owner, memberId, false, undefined, stepUpToken, ip);
  }

  private async apply(owner: Owner, memberId: string, suspend: boolean, reason: SuspensionReason | undefined, stepUpToken: string | undefined, ip: string) {
    const type = suspend ? 'account.disabled' : 'account.enabled';
    const operation = suspend ? 'suspend' : 'restore';
    try {
      const out = await this.db.tx(async (q) => {
        const companyId = await this.users.ownerCompany(owner.userId, q);
        if (!companyId) throw notFound();
        await this.stepUp.consume(q, { ownerId: owner.userId, sid: owner.sid, purpose: suspend ? 'account.suspend' : 'account.restore', token: stepUpToken });
        const active = await this.eligibleMember(q, memberId, companyId);
        if (active === !suspend) return { id: memberId, suspended: suspend, changed: false };

        await this.users.setActive(memberId, !suspend, q);
        if (suspend) await this.refresh.revokeAllForUser(q, memberId);
        await this.audit.record({ type, outcome: 'success', actorId: owner.userId, targetId: memberId, sessionFamilyId: owner.sid, ip, metadata: { kind: 'member', ...(reason ? { reason } : {}) } }, q);
        await this.central.write(q, {
          action: type, actor: ownerActor(owner), organizationId: null, resource: { type: 'user', id: memberId }, outcome: 'succeeded', ...(reason ? { changes: { reason } } : {}),
        } as never);
        return { id: memberId, suspended: suspend, changed: true };
      });
      this.counters.count(operation, out.changed ? 'changed' : 'unchanged');
      return out;
    } catch (e) {
      if (!(e instanceof NotEligible)) {
        this.counters.count(operation, e instanceof HttpException && e.getStatus() === 403 ? 'step_up_denied' : 'failed');
        throw e;
      }
      this.counters.count(operation, 'target_refused');
      // Local security evidence of the refusal (the transaction, and the step-up consumption with it, rolled back). Never shown to the caller.
      await this.audit.tryRecord({ type, outcome: 'denied', actorId: owner.userId, targetId: memberId, sessionFamilyId: owner.sid, ip, metadata: { kind: 'member', why: e.why } });
      throw notFound();
    }
  }

  /** Locks the target and proves it is a member of THIS Company only. Returns its current `isActive`. */
  private async eligibleMember(q: Queryable, memberId: string, companyId: string): Promise<boolean> {
    const { rows: u } = await q.query<{ kind: string; isActive: boolean }>(`SELECT kind, "isActive" FROM "user" WHERE id=$1 FOR UPDATE`, [memberId]);
    if (!u[0] || u[0].kind !== 'member') throw new NotEligible('not_a_member');
    const { rows } = await q.query<{ inCompany: boolean | null; elsewhere: boolean | null }>(
      `SELECT bool_or(m.status = 'active' AND p."companyId" = $2)                      AS "inCompany",
              bool_or(m.status IN ('active', 'pending') AND p."companyId" <> $2)       AS "elsewhere"
         FROM organization_membership m
         JOIN organization o ON o.id = m."organizationId"
         JOIN platform p     ON p.id = o."platformId"
        WHERE m."userId" = $1`,
      [memberId, companyId],
    );
    if (rows[0]?.elsewhere) throw new NotEligible('other_company');
    if (!rows[0]?.inCompany) throw new NotEligible('not_in_company');
    return u[0].isActive;
  }
}
