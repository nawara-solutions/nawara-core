import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CentralAudit, ownerActor } from '../audit/central-audit.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { DbService, isUniqueViolation, type Queryable } from '../db/db.service.js';
import { authError, notFound } from '../errors.js';
import { StepUpService } from '../owner/step-up.service.js';

export interface OwnerActor {
  userId: string;
  sid: string;
}

/**
 * PlatformAssignment mutations. Security properties:
 *  - the actor is ALWAYS the authenticated owner; assignedBy / revokedBy / companyId are derived here
 *    from that identity and the database, never read from a request body (the DTO whitelist also
 *    rejects them),
 *  - operator and platform must both be in the OWNER'S company (404 otherwise, collapsed),
 *  - a fresh, purpose- and session-bound step-up is consumed in the SAME transaction (a failed
 *    mutation does not burn it),
 *  - race safety comes from the database (partial unique index); the service maps 23505 -> 409,
 *  - history is append-only: revoke marks, never deletes; re-grant inserts a new row.
 */
@Injectable()
export class AssignmentService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CentralAudit) private readonly central: CentralAudit,
  ) {}

  private async ownerCompany(q: Queryable, ownerId: string): Promise<string> {
    const { rows } = await q.query(`SELECT o."companyId" FROM owner o JOIN "user" u ON u.id=o."userId" WHERE o."userId"=$1 AND u."isActive"`, [ownerId]);
    if (!rows[0]) throw notFound();
    return rows[0].companyId;
  }

  private async assertOperatorInCompany(q: Queryable, operatorId: string, companyId: string) {
    const { rowCount } = await q.query(`SELECT 1 FROM operator WHERE "userId"=$1 AND "companyId"=$2`, [operatorId, companyId]);
    if (!rowCount) throw notFound();
  }

  async grant(actor: OwnerActor, operatorId: string, platformId: string, stepUpToken: string | undefined, ip: string) {
    const row = await this.db.tx(async (q) => {
      const companyId = await this.ownerCompany(q, actor.userId);
      await this.assertOperatorInCompany(q, operatorId, companyId);
      const pl = await q.query(`SELECT 1 FROM platform WHERE id=$1 AND "companyId"=$2`, [platformId, companyId]);
      if (!pl.rowCount) throw notFound();
      await this.stepUp.consume(q, { ownerId: actor.userId, sid: actor.sid, purpose: 'platform_assignment.grant', token: stepUpToken });
      try {
        const { rows } = await q.query(
          `INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy","assignedAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$5,$5) RETURNING id, "platformId", "assignedBy", "assignedAt", "revokedAt", active`,
          [operatorId, platformId, companyId, actor.userId, this.clock.now()],
        );
        await this.audit.record({ type: 'platform_assignment.grant', outcome: 'success', actorId: actor.userId, targetId: operatorId, sessionFamilyId: actor.sid, ip, metadata: { platformId } }, q);
        // Stage 18.7.6: the central audit intent, same transaction; the platform is the assignment row's.
        await this.central.write(q, {
          action: 'platform_assignment.granted', actor: ownerActor(actor), organizationId: null, resource: { type: 'platform_assignment', id: rows[0].id },
          subject: { type: 'user', id: operatorId }, outcome: 'succeeded', changes: { platform_id: rows[0].platformId },
        });
        return rows[0];
      } catch (e) {
        if (isUniqueViolation(e, 'platform_assignment_one_active')) throw authError(409, 'assignment_conflict', 'An active assignment already exists.');
        throw e;
      }
    });
    return row;
  }

  async revoke(actor: OwnerActor, operatorId: string, platformId: string, stepUpToken: string | undefined, ip: string) {
    await this.db.tx(async (q) => {
      const companyId = await this.ownerCompany(q, actor.userId);
      await this.assertOperatorInCompany(q, operatorId, companyId);
      await this.stepUp.consume(q, { ownerId: actor.userId, sid: actor.sid, purpose: 'platform_assignment.revoke', token: stepUpToken });
      const now = this.clock.now();
      const { rows } = await q.query(
        `UPDATE platform_assignment SET active=false, "revokedAt"=$5, "revokedBy"=$4, "updatedAt"=$5
          WHERE "operatorId"=$1 AND "platformId"=$2 AND "companyId"=$3 AND active RETURNING id, "platformId"`,
        [operatorId, platformId, companyId, actor.userId, now],
      );
      if (rows.length !== 1) throw notFound(); // rolls back: the step-up is not burned
      await this.audit.record({ type: 'platform_assignment.revoke', outcome: 'success', actorId: actor.userId, targetId: operatorId, sessionFamilyId: actor.sid, ip, metadata: { platformId } }, q);
      await this.central.write(q, {
        action: 'platform_assignment.revoked', actor: ownerActor(actor), organizationId: null, resource: { type: 'platform_assignment', id: rows[0].id },
        subject: { type: 'user', id: operatorId }, outcome: 'succeeded', changes: { platform_id: rows[0].platformId },
      });
    });
  }

  async history(actor: OwnerActor, operatorId: string) {
    const companyId = await this.ownerCompany(this.db, actor.userId);
    await this.assertOperatorInCompany(this.db, operatorId, companyId);
    const { rows } = await this.db.query(
      `SELECT id,"platformId","assignedBy","assignedAt","revokedAt","revokedBy",active FROM platform_assignment WHERE "operatorId"=$1 AND "companyId"=$2 ORDER BY "assignedAt"`,
      [operatorId, companyId],
    );
    return rows;
  }
}
