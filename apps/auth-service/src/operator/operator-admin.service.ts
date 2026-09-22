import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { DbService } from '../db/db.service.js';
import { notFound } from '../errors.js';
import { StepUpService } from '../owner/step-up.service.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { UsersService, toIdentifier } from '../users/users.service.js';
import { OperatorCodeService } from './operator-code.service.js';

/** Owner-only operator lifecycle. All company scoping is derived from the authenticated owner. */
@Injectable()
export class OperatorAdminService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(OperatorCodeService) private readonly codes: OperatorCodeService,
    @Inject(RefreshTokenService) private readonly refresh: RefreshTokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(owner: { userId: string; sid: string }, ident: { email?: string; phone?: string }, stepUpToken: string | undefined, ip: string) {
    const id = toIdentifier(ident);
    return this.db.tx(async (q) => {
      const companyId = await this.users.ownerCompany(owner.userId, q);
      if (!companyId) throw notFound();
      await this.stepUp.consume(q, { ownerId: owner.userId, sid: owner.sid, purpose: 'operator.create', token: stepUpToken });
      const op = await this.users.createOperator({ companyId, ...id }, q);
      await this.codes.issueConfirmation(q, op);
      await this.audit.record({ type: 'operator.create', outcome: 'success', actorId: owner.userId, targetId: op.id, sessionFamilyId: owner.sid, ip }, q);
      return { id: op.id, email: op.email, phone: op.phone, isActive: op.isActive };
    });
  }

  private async scoped(ownerId: string, operatorId: string) {
    const companyId = await this.users.ownerCompany(ownerId);
    const { rowCount } = await this.db.query(`SELECT 1 FROM operator WHERE "userId"=$1 AND "companyId"=$2`, [operatorId, companyId]);
    if (!companyId || !rowCount) throw notFound();
  }

  /** Blocking is an EMERGENCY control, deliberately not behind step-up: it ends every session now. */
  async setBlocked(owner: { userId: string; sid: string }, operatorId: string, blocked: boolean, ip: string) {
    await this.scoped(owner.userId, operatorId);
    await this.db.tx(async (q) => {
      await this.users.setActive(operatorId, !blocked, q);
      if (blocked) {
        await q.query(`UPDATE admin_operator_code SET "supersededAt"=now() WHERE "userId"=$1 AND "consumedAt" IS NULL AND "supersededAt" IS NULL`, [operatorId]);
        await this.refresh.revokeAllForUser(q, operatorId);
      }
      await this.audit.record({ type: blocked ? 'account.disabled' : 'account.enabled', outcome: 'success', actorId: owner.userId, targetId: operatorId, sessionFamilyId: owner.sid, ip }, q);
    });
  }
}
