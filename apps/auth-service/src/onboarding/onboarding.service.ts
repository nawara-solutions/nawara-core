import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CentralAudit, userActor } from '../audit/central-audit.js';
import type { ClientInfo } from '../common/client-info.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { generateJoinCode, hashJoinCode, normalizeJoinCode } from '../crypto/join-code.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { authError, notFound } from '../errors.js';
import { HierarchyReference } from '../hierarchy/hierarchy-reference.js';
import { StepUpService } from '../owner/step-up.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import type { UserKind } from '../users/users.service.js';

/** One generic answer for every reason a code cannot be used (unknown, malformed, expired, revoked, exhausted). */
export const JOIN_CODE_INVALID = 'Invalid or expired code.';

export interface OrgActor {
  userId: string;
  kind: UserKind;
  sid: string;
}

export interface ResolvedJoinCode {
  id: string;
  organizationId: string;
  platformId: string;
  audience: string;
  requiresApproval: boolean;
  requiresSubscription: boolean;
  organizationName: string;
  platformName: string;
  platformKey: string | null;
}

export type CodeRejection = 'malformed' | 'unknown' | 'inactive' | 'revoked' | 'expired' | 'exhausted';

const DAY_MS = 86_400_000;

/**
 * Organization join codes (ADR-0028). The client only ever supplies the code; organization, platform
 * and audience are resolved HERE from the database row the code's HMAC matches, so none of them can be
 * chosen or altered by the caller. Join codes are onboarding credentials: they are rate limited, never
 * stored in plaintext, never logged, and every failure is the same generic answer (the reason goes to
 * the audit trail only).
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CentralAudit) private readonly central: CentralAudit,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(PlatformAccessService) private readonly access: PlatformAccessService,
    @Inject(HierarchyReference) private readonly hierarchy: HierarchyReference,
  ) {}

  /** Shared brute-force guard for every endpoint that accepts a join code (resolve AND register). */
  async guardGuessing(client: ClientInfo): Promise<void> {
    await this.throttle.hit('join_code_resolve_global', 'all');
    await this.throttle.hit('join_code_resolve_ip', client.ip);
  }

  /** Read-only lookup: the row and, if it cannot be used, exactly why (for the audit trail only). */
  async lookup(rawCode: string, q: Queryable = this.db): Promise<{ row: ResolvedJoinCode } | { rejected: CodeRejection }> {
    const normalized = normalizeJoinCode(rawCode);
    if (!normalized) return { rejected: 'malformed' };
    const { rows } = await q.query(
      `SELECT c.id, c."organizationId", c."platformId", c.audience, c."requiresApproval", c."requiresSubscription",
              c."isActive", c."revokedAt", c."expiresAt", c."maxUses", c."usedCount",
              o.name AS "organizationName", p.name AS "platformName", p.key AS "platformKey"
         FROM organization_join_code c
         JOIN organization o ON o.id = c."organizationId"
         JOIN platform p ON p.id = c."platformId"
        WHERE c."codeHash" = $1`,
      [hashJoinCode(this.cfg.secrets.joinCodePepper, normalized)],
    );
    const c = rows[0];
    if (!c) return { rejected: 'unknown' };
    const now = this.clock.now();
    if (c.revokedAt) return { rejected: 'revoked' };
    if (!c.isActive) return { rejected: 'inactive' };
    if (c.expiresAt && c.expiresAt <= now) return { rejected: 'expired' };
    if (c.maxUses !== null && c.usedCount >= c.maxUses) return { rejected: 'exhausted' };
    return { row: c as ResolvedJoinCode };
  }

  /** POST /auth/onboarding/resolve — safe context for the app; reveals nothing about a bad code. */
  async resolve(rawCode: string, client: ClientInfo) {
    await this.guardGuessing(client);
    const r = await this.lookup(rawCode);
    if ('rejected' in r) {
      await this.audit.tryRecord({ type: 'onboarding.join_code.resolve_failed', outcome: 'failure', ip: client.ip, metadata: { reason: r.rejected } });
      throw authError(404, 'join_code_invalid', JOIN_CODE_INVALID);
    }
    const c = r.row;
    return {
      platform: { id: c.platformId, key: c.platformKey, name: c.platformName },
      organization: { id: c.organizationId, name: c.organizationName },
      audience: c.audience,
      requiresSubscription: c.requiresSubscription,
      requiresOrganizationApproval: c.requiresApproval,
      requiresVerification: this.cfg.onboarding.requireContactVerification,
    };
  }

  /**
   * Atomically spends ONE use of the code inside the caller's transaction. The single conditional
   * UPDATE re-checks every condition, so two simultaneous registrations can never exceed maxUses and a
   * code revoked or expired since the lookup is refused. If the surrounding transaction fails, the
   * increment rolls back with it.
   */
  async redeem(q: Queryable, rawCode: string): Promise<ResolvedJoinCode> {
    const normalized = normalizeJoinCode(rawCode);
    if (!normalized) throw authError(403, 'join_code_invalid', JOIN_CODE_INVALID);
    const { rows } = await q.query(
      `UPDATE organization_join_code SET "usedCount" = "usedCount" + 1
        WHERE "codeHash" = $1 AND "isActive" AND "revokedAt" IS NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > $2)
          AND ("maxUses" IS NULL OR "usedCount" < "maxUses")
        RETURNING id, "organizationId", "platformId", audience, "requiresApproval", "requiresSubscription"`,
      [hashJoinCode(this.cfg.secrets.joinCodePepper, normalized), this.clock.now()],
    );
    if (!rows[0]) throw authError(403, 'join_code_invalid', JOIN_CODE_INVALID);
    return rows[0] as ResolvedJoinCode;
  }

  // ------------------------------------------------------------------------- administration
  private async authorize(q: Queryable, actor: OrgActor, organizationId: string) {
    const authority = await this.access.organizationAuthority(actor.userId, organizationId, q);
    if (!authority) throw notFound(); // "no such organization", "not yours" and "not allowed" are one 404
    return authority;
  }

  /** Creates a join code. The plaintext is returned ONCE and is not recoverable afterwards. */
  async create(
    actor: OrgActor, organizationId: string,
    dto: { audience: string; requiresApproval: boolean; requiresSubscription: boolean; expiresInDays?: number; maxUses?: number },
    stepUpToken: string | undefined, ip: string,
  ) {
    await this.throttle.hit('join_code_manage_actor', actor.userId);
    // Stage 21.C.2 (ADR-0040 decision 2): an administrative first touch. With Organization Service as the source, a not-yet-cached
    // Organization is placed by `ensure` (bounded, fail closed) BEFORE the local authority check reads its anchors. Unknown: the usual 404.
    if (!(await this.hierarchy.firstTouchOrganization(organizationId))) throw notFound();
    return this.db.tx(async (q) => {
      const authority = await this.authorize(q, actor, organizationId);
      if (authority === 'owner') {
        await this.stepUp.consume(q, { ownerId: actor.userId, sid: actor.sid, purpose: 'join_code.create', token: stepUpToken });
      }
      const p = await this.access.platformOfOrganization(organizationId, q);
      const platform = await q.query(`SELECT key FROM platform WHERE id = $1`, [p!.platformId]);
      const code = generateJoinCode(platform.rows[0]?.key ?? undefined);
      const now = this.clock.now();
      const expiresAt = new Date(now.getTime() + (dto.expiresInDays ?? 30) * DAY_MS);
      const { rows } = await q.query(
        `INSERT INTO organization_join_code("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","expiresAt","maxUses","createdBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, audience, "requiresApproval", "requiresSubscription", "expiresAt", "maxUses", "usedCount", "createdAt", "organizationId"`,
        [organizationId, p!.platformId, hashJoinCode(this.cfg.secrets.joinCodePepper, code.normalized), dto.audience,
          dto.requiresApproval, dto.requiresSubscription, expiresAt, dto.maxUses ?? null, actor.userId],
      );
      const { organizationId: persistedOrganization, ...created } = rows[0];
      await this.audit.record({
        type: 'onboarding.join_code.created', outcome: 'success', actorId: actor.userId, targetId: rows[0].id, sessionFamilyId: actor.sid, ip,
        metadata: { organizationId, audience: dto.audience, authority },
      }, q);
      // Stage 18.7.6: the central audit intent, same transaction; the organization is the code row's.
      await this.central.write(q, {
        action: 'join_code.created', actor: userActor(actor), organizationId: persistedOrganization, resource: { type: 'join_code', id: created.id },
        outcome: 'succeeded', changes: { authority },
      });
      return { ...created, code: code.display };
    });
  }

  async revoke(actor: OrgActor, organizationId: string, codeId: string, stepUpToken: string | undefined, ip: string): Promise<void> {
    await this.throttle.hit('join_code_manage_actor', actor.userId);
    await this.db.tx(async (q) => {
      const authority = await this.authorize(q, actor, organizationId);
      if (authority === 'owner') {
        await this.stepUp.consume(q, { ownerId: actor.userId, sid: actor.sid, purpose: 'join_code.revoke', token: stepUpToken });
      }
      const now = this.clock.now();
      const { rows } = await q.query(
        `UPDATE organization_join_code SET "isActive" = false, "revokedAt" = $3, "revokedBy" = $4
          WHERE id = $1 AND "organizationId" = $2 AND "revokedAt" IS NULL RETURNING "organizationId"`,
        [codeId, organizationId, now, actor.userId],
      );
      if (rows.length !== 1) throw notFound(); // rolls back: the step-up is not burned
      await this.audit.record({ type: 'onboarding.join_code.revoked', outcome: 'success', actorId: actor.userId, targetId: codeId, sessionFamilyId: actor.sid, ip, metadata: { organizationId, authority } }, q);
      await this.central.write(q, {
        action: 'join_code.revoked', actor: userActor(actor), organizationId: rows[0].organizationId, resource: { type: 'join_code', id: codeId },
        outcome: 'succeeded', changes: { authority },
      });
    });
  }

  /** Metadata only: the plaintext code cannot be shown again. */
  async list(actor: OrgActor, organizationId: string) {
    await this.authorize(this.db, actor, organizationId);
    const { rows } = await this.db.query(
      `SELECT id, audience, "requiresApproval", "requiresSubscription", "expiresAt", "maxUses", "usedCount", "isActive", "createdAt", "revokedAt"
         FROM organization_join_code WHERE "organizationId" = $1 ORDER BY "createdAt" DESC`,
      [organizationId],
    );
    return rows;
  }
}

