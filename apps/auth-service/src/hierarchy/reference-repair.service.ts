import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { CentralAudit, ownerActor, userActor } from '../audit/central-audit.js';
import type { Actor } from '../auth/auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { authError, forbidden, notFound } from '../errors.js';
import { AUTH_MESSAGES } from '../messages.js';
import { StepUpService } from '../owner/step-up.service.js';
import { ThrottleService } from '../throttle/throttle.service.js';
import type { ReferenceRepairResponseDto } from './dto.js';
import { HierarchyReference } from './hierarchy-reference.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS: readonly string[] = ['platform', 'organization'];
/**
 * Only `repair` touches the hierarchy module (the A5.4-T1 boundary: in this file, only the approved operation reaches it), so the few
 * shapes the rest of the file needs are written out here: the repairable kinds and the closed list of local failure reasons (design
 * §8.2), and the same `503` the hierarchy module raises.
 */
type Kind = 'platform' | 'organization';
type FailureReason =
  | 'authority_unavailable' | 'authority_timeout' | 'authority_redirect' | 'authority_response_invalid'
  | 'credential_missing' | 'credential_refused' | 'parent_missing' | 'placement_refused' | 'audit_intent_unwritable'
  | 'step_up_consume_failed' | 'step_up_consume_uncertain'
  | 'auth_database_unavailable'; // owner ruling of 2026-10-10: Auth's own database failed after the proof was consumed
const unavailable = () => authError(503, 'hierarchy_unavailable', AUTH_MESSAGES.hierarchyUnavailable);

/**
 * Whether the repair may run, read on every request (A5.4-A3 O15; the dated clarification of ADR-0061): `eligible` only with the
 * configured source `organization-service` AND the marker `org_authoritative`; `frozen` proceeds as ADR-0061 §5 describes (the
 * database refuses a placement); `inert` (the source `local`, or the marker `local`) does nothing at all; `unreadable` fails closed.
 */
type RepairState = 'eligible' | 'frozen' | 'inert' | 'unreadable';

/**
 * The hierarchy reference repair (ADR-0061 §3 to §6, as partly superseded by ADR-0064 and ADR-0065; the A5.4-A3 design §3 to §11).
 *
 * The order of checks (design §3.3): 1a authentication (the guard); 1b the Owner (`403`); 1c the source and the marker (the collapsed
 * `404` when inert, `503` when the marker cannot be read); 2a validation (`400`); 2b the rate limits (`429`); 3 the proof, consumed on
 * its own and committed before any lookup (`403`, or `503` when the outcome is not a clean success or rejection); then resolve,
 * authorize, place with the success record in the same transaction, and answer.
 *
 * Records (ADR-0064 §4; the design §7, §8, §11.6): the success in the placement transaction; the denial, the unresolved target and the
 * anchor mismatch best effort in their own transaction, with Auth's local audit as the fallback; an infrastructure failure locally only,
 * with a warning line. A denial is recorded only when the repair is eligible (marker `org_authoritative`); nothing at all is recorded
 * while the repair is inert. This service is the only producer of the four reference-repair audit actions (A5.4-A3 O2, O10).
 */
@Injectable()
export class ReferenceRepairService {
  private readonly log = new Logger('ReferenceRepair');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(StepUpService) private readonly stepUp: StepUpService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CentralAudit) private readonly central: CentralAudit,
    @Inject(HierarchyReference) private readonly hierarchy: HierarchyReference,
  ) {}

  async repair(actor: Actor, kind: string, rawId: string, stepUpToken: string | undefined, ip: string): Promise<ReferenceRepairResponseDto> {
    const id = rawId.toLowerCase();
    const recordable = KINDS.includes(kind) && UUID.test(id);
    const who = { actorId: actor.userId, sessionFamilyId: actor.sid, ip };

    // 1b. The active Company Owner, from the database (the guard has checked that the user and the session are active).
    const companyId = actor.kind === 'owner' ? await this.ownerCompany(actor.userId) : null;
    if (!companyId) {
      // C2: 403 in every state; a repair record only when the repair is eligible. A failed marker read changes nothing here.
      const state = await this.state().catch((): RepairState => 'unreadable');
      if (state === 'eligible') {
        const local: AuditEvent = { type: 'hierarchy.reference_repair.denied', outcome: 'denied', ...who, targetId: recordable ? id : null, metadata: { kind, reason: 'no_authority' } };
        if (recordable) {
          await this.bestEffort((q) => this.central.write(q, {
            action: 'hierarchy.reference_repair_denied', actor: userActor({ userId: actor.userId, kind: actor.kind }), organizationId: null,
            resource: { type: kind as Kind, id }, outcome: 'denied', changes: { reason: 'no_authority' },
          }), local);
        } else {
          await this.audit.tryRecord(local); // O3: what the central contract cannot describe is recorded locally only
        }
      }
      throw forbidden();
    }

    // 1c. Inert unless Organization Service is the authority; an unreadable marker is never taken as Organization-authoritative.
    const state = await this.state();
    if (state === 'inert') throw notFound();
    if (state === 'unreadable') throw unavailable();

    // 2a, 2b.
    if (!recordable) throw authError(400, 'validation_error', 'kind must be platform or organization and id a UUID');
    const target = kind as Kind;
    await this.throttle.hit('reference_repair_owner', actor.userId);
    await this.throttle.hit('reference_repair_ip', ip);

    // 3. The proof, consumed on its own and committed before any lookup (ADR-0061 §4 step 3; ADR-0065 §5).
    const proof = await this.stepUp.consumeForReferenceRepair({ ownerId: actor.userId, sid: actor.sid, token: stepUpToken });
    if (proof === 'rejected') {
      if (state === 'eligible') {
        await this.bestEffort((q) => this.central.write(q, {
          action: 'hierarchy.reference_repair_denied', actor: ownerActor(actor), organizationId: null,
          resource: { type: target, id }, outcome: 'denied', changes: { reason: 'step_up_required' },
        }), { type: 'hierarchy.reference_repair.denied', outcome: 'denied', ...who, targetId: id, metadata: { kind: target, reason: 'step_up_required' } });
      }
      throw authError(403, 'step_up_required', AUTH_MESSAGES.stepUpRequired);
    }
    if (proof !== 'consumed') return this.failed(target, id, proof === 'not_consumed' ? 'step_up_consume_failed' : 'step_up_consume_uncertain', who);

    // 4 to 7. Resolve without writing, authorize the Company, then place with the success record in the same transaction.
    let result: Awaited<ReturnType<HierarchyReference['repairReference']>>;
    try {
      result = await this.hierarchy.repairReference(target, id, {
        authorize: (company) => company === companyId,
        record: (q: Queryable, { placed }) => this.central.write(q, {
          action: 'hierarchy.reference_repaired', actor: ownerActor(actor), organizationId: target === 'organization' ? id : null,
          resource: { type: target, id }, outcome: 'succeeded', changes: { placed },
        }),
      });
    } catch {
      // `repairReference` classifies every hierarchy failure itself (authority, parent, placement, record, mismatch) and rethrows only
      // what is not one: in practice a failure of Auth's own database while it reads the cache. Any other unclassified error that
      // reaches here (a programming error, for example) is given the same label; a database failure INSIDE the placement transaction is
      // `placement_refused`, as slice B classifies it. The proof is already consumed, so this is a failed repair (ADR-0061 §6): recorded
      // locally with its own reason, never centrally, and answered `503` (fail closed).
      return this.failed(target, id, 'auth_database_unavailable', who);
    }

    switch (result.outcome) {
      case 'repaired':
        return { kind: target, id, placed: result.placed };
      case 'unresolved':
        // ADR-0064 D1: one record for "unknown", "outside Auth's scope" and "another Company", best effort.
        await this.bestEffort((q) => this.central.write(q, {
          action: 'hierarchy.reference_repair_unresolved', actor: ownerActor(actor), organizationId: null,
          resource: { type: target, id }, outcome: 'denied', changes: { reason: 'unresolved' },
        }), { type: 'hierarchy.reference_repair.unresolved', outcome: 'denied', ...who, targetId: id, metadata: { kind: target } });
        throw notFound();
      case 'anchor_mismatch': {
        // ADR-0064 D3: a security incident, written after the rollback; the alert log line is the hierarchy module's.
        const at = result.at;
        await this.bestEffort((q) => this.central.write(q, {
          action: 'hierarchy.reference_anchor_mismatch_detected', actor: { type: 'system', id: 'hierarchy_anchor_detection' }, organizationId: null,
          resource: { type: at.kind, id: at.id }, outcome: 'denied', changes: { operation: 'reference_repair' },
        }), { type: 'hierarchy.reference_repair.anchor_mismatch', outcome: 'denied', ...who, targetId: at.id, metadata: { kind: at.kind, operation: 'reference_repair' } });
        throw unavailable();
      }
      case 'failed':
        return this.failed(target, id, result.reason, who);
    }
  }

  /** The Company of the active Owner, or null: a user of kind owner without an owner row has no authority (design §3.3). */
  private async ownerCompany(userId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ companyId: string }>(
      `SELECT o."companyId" FROM owner o JOIN "user" u ON u.id = o."userId" WHERE o."userId" = $1 AND u."isActive"`, [userId]);
    return rows[0]?.companyId ?? null;
  }

  /** The source, then (only when it is `organization-service`) the marker. Throws nothing: a read that fails is `unreadable`. */
  private async state(): Promise<RepairState> {
    if (this.cfg.hierarchy.source !== 'organization-service') return 'inert';
    let mode: unknown;
    try {
      const { rows } = await this.db.query<{ mode: unknown }>('SELECT mode FROM hierarchy_authority');
      if (rows.length !== 1) return 'unreadable';
      mode = rows[0]!.mode;
    } catch {
      return 'unreadable';
    }
    if (mode === 'org_authoritative') return 'eligible';
    if (mode === 'frozen') return 'frozen';
    if (mode === 'local') return 'inert';
    return 'unreadable';
  }

  /**
   * ADR-0064 D2 (and ADR-0061 §6 for `auth_database_unavailable`): an infrastructure failure is recorded locally, never centrally; the
   * answer is `503`. The warning line comes first, so it is emitted even when the local record cannot be written (best effort).
   */
  private async failed(kind: Kind, id: string, reason: FailureReason, who: { actorId: string; sessionFamilyId: string; ip: string }): Promise<never> {
    this.log.warn(`hierarchy_reference_repair_failed kind=${kind} id=${id} reason=${reason}`);
    await this.audit.tryRecord({ type: 'hierarchy.reference_repair.failed', outcome: 'failure', ...who, targetId: id, metadata: { kind, reason } });
    throw unavailable();
  }

  /** ADR-0064 D4: the central record in its own transaction; if that fails, Auth's local audit, then (inside `tryRecord`) a log line. */
  private async bestEffort(write: (q: Queryable) => Promise<void>, local: AuditEvent): Promise<void> {
    try {
      await this.db.tx(write);
    } catch {
      await this.audit.tryRecord(local);
    }
  }
}
