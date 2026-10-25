import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { validateAuditEvent } from '@nawara/audit-contract/consumer';
import { DbService, RateLimitService, getRequestContext, httpError, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { AUDIT_CONFIG } from '../config/audit-config.token.js';
import { SERVICE_NAME, type AuditConfig } from '../config/audit-config.js';
import { AUDIT_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type LiveGrants, type OwnerAuthority } from '../owner/owner-authority.client.js';
import { toNewAuditRecord } from '../persistence/audit-record.mapper.js';
import { AuditRecordRepository } from '../persistence/audit-record.repository.js';
import { QUERY_WINDOW_SECONDS } from '../query/query.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** H6: a validated reason code (the receipt `reason` rule: a bounded code, never free text). */
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** An occurrence-window bound: a UTC instant, to the millisecond at most. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;

export interface PlacedHold { holdId: string; companyId: string; reasonCode: string; from: string | null; to: string | null; placedAt: string }
export interface ReleasedHold { holdId: string; releasedAt: string }

const invalid = () => httpError(400, 'invalid_request', AUDIT_MESSAGES.legalHoldInvalid);
const notFound = () => new HttpException({ message: 'Not Found', code: 'not_found' }, 404);

/**
 * Core V2 S2-Audit.4 (ADR-0069 decision 6; register AUD-05; OD-13 resolved, Owner decisions H1 to H7): legal holds on a Company's TRUSTED
 * audit evidence. Only the active Owner of the Company, verified live by Auth on every request (`/auth/grants`), with a fresh,
 * factor-only, purpose-specific step-up that Auth consumes (`/auth/step-up/verify`); the Company is Auth's answer, never a request value.
 *
 * Order (both operations): live grants (an owner and its Company) → rate limit per verified owner → strict body → [release: the hold must be
 * an ACTIVE hold of the owner's Company, checked BEFORE the proof is spent] → Auth consumes the proof → ONE transaction: the Company's hold
 * lock EXCLUSIVE, the hold event, its `audit_legal_hold.*` record. There is no distributed transaction: if Audit cannot commit after Auth
 * consumed the proof, the request fails closed (503) and nothing changed; a fresh proof is needed to try again.
 *
 * Coverage (H7): records with a trusted Company scope row for the Company, within the optional window; nothing else. No expiry (H5).
 */
@Injectable()
export class LegalHoldService {
  private readonly log = new Logger('AuditLegalHold');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuditRecordRepository) private readonly records: AuditRecordRepository,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
    @Optional() @Inject(OWNER_AUTHORITY) private readonly authority?: OwnerAuthority,
  ) {}

  async place(userBearer: string, body: unknown): Promise<PlacedHold> {
    const { owner, companyId, deadline } = await this.owner(userBearer);
    const b = strictBody(body, ['stepUpToken', 'reasonCode', 'from', 'to']);
    const reasonCode = reason(b.reasonCode);
    const stepUpToken = proof(b.stepUpToken);
    if ((b.from === undefined) !== (b.to === undefined)) throw invalid(); // a window has both bounds, or none
    const from = b.from === undefined ? null : instant(b.from);
    const to = b.to === undefined ? null : instant(b.to);
    if (from && to && from.getTime() >= to.getTime()) throw invalid();

    await this.authority!.verifyStepUp(userBearer, 'audit.legal_hold.place', stepUpToken, deadline);
    const holdId = randomUUID();
    const placedAt = await this.committed('place', async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(audit_legal_hold_lock_key($1::uuid))', [companyId]);
      const { rows } = await q.query<{ createdAt: Date }>(
        `INSERT INTO audit_legal_hold_event ("holdId", kind, "companyId", "windowFrom", "windowTo", "reasonCode", "actorUserId")
         VALUES ($1, 'placed', $2, $3, $4, $5, $6) RETURNING "createdAt"`,
        [holdId, companyId, from, to, reasonCode, owner],
      );
      await this.recordOwn(q, 'audit_legal_hold.placed', owner, holdId, {
        company_id: companyId, reason_code: reasonCode,
        ...(from && to ? { window_from: from.toISOString(), window_to: to.toISOString() } : {}),
      });
      return rows[0]!.createdAt;
    });
    this.log.log(`audit_legal_hold_placed hold=${holdId} windowed=${from !== null}`);
    return { holdId, companyId, reasonCode, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, placedAt: placedAt.toISOString() };
  }

  async release(userBearer: string, holdParam: unknown, body: unknown): Promise<ReleasedHold> {
    const { owner, companyId, deadline } = await this.owner(userBearer);
    if (typeof holdParam !== 'string' || !UUID.test(holdParam)) throw notFound();
    const holdId = holdParam;
    const b = strictBody(body, ['stepUpToken', 'reasonCode']);
    const reasonCode = reason(b.reasonCode);
    const stepUpToken = proof(b.stepUpToken);
    // H4: an unknown, foreign or already-released hold is the same 404, BEFORE the proof is spent (nothing tells them apart)
    if (!(await this.isActiveHoldOf(this.db, holdId, companyId))) throw notFound();

    await this.authority!.verifyStepUp(userBearer, 'audit.legal_hold.release', stepUpToken, deadline);
    const releasedAt = await this.committed('release', async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(audit_legal_hold_lock_key($1::uuid))', [companyId]);
      if (!(await this.isActiveHoldOf(q, holdId, companyId))) throw notFound(); // released meanwhile (a concurrent release won)
      const { rows } = await q.query<{ createdAt: Date }>(
        `INSERT INTO audit_legal_hold_event ("holdId", kind, "companyId", "reasonCode", "actorUserId")
         VALUES ($1, 'released', $2, $3, $4) RETURNING "createdAt"`,
        [holdId, companyId, reasonCode, owner],
      );
      await this.recordOwn(q, 'audit_legal_hold.released', owner, holdId, { company_id: companyId, reason_code: reasonCode });
      return rows[0]!.createdAt;
    }).catch((e: unknown) => {
      if (isUniqueViolation(e, 'audit_legal_hold_event_once')) throw notFound(); // the same release twice: one wins
      throw e;
    });
    this.log.log(`audit_legal_hold_released hold=${holdId}`);
    return { holdId, releasedAt: releasedAt.toISOString() };
  }

  /** H1: the active Owner and their Company, from Auth's live answer; every other identity is refused. */
  private async owner(userBearer: string): Promise<{ owner: string; companyId: string; deadline: AbortSignal }> {
    if (!this.authority) throw notFound(); // not configured: no route
    const deadline = AbortSignal.timeout(this.config.ownerAccess?.authTimeoutMs ?? 3_000);
    const g: LiveGrants = await this.authority.grants(userBearer, deadline);
    if (g.kind !== 'owner' || g.companyId === null) throw httpError(403, 'operation_not_allowed', AUDIT_MESSAGES.ownerOnly);
    const r = await this.limiter.hit('audit_query_owner', g.userId, { limit: this.config.ownerAccess?.ratePerOwner ?? 1, windowSec: QUERY_WINDOW_SECONDS });
    if (!r.allowed) throw httpError(429, 'rate_limited', AUDIT_MESSAGES.tooManyRequests);
    return { owner: g.userId, companyId: g.companyId, deadline };
  }

  private async isActiveHoldOf(q: Queryable, holdId: string, companyId: string): Promise<boolean> {
    const { rows } = await q.query(
      `SELECT 1 FROM audit_legal_hold_event p
        WHERE p."holdId" = $1 AND p.kind = 'placed' AND p."companyId" = $2
          AND NOT EXISTS (SELECT 1 FROM audit_legal_hold_event x WHERE x."holdId" = p."holdId" AND x.kind = 'released')`,
      [holdId, companyId],
    );
    return rows.length === 1;
  }

  /** The hold change and its record commit together; anything else is a 503 with nothing changed (the proof is already spent). */
  private async committed<T>(what: 'place' | 'release', fn: (q: Queryable) => Promise<T>): Promise<T> {
    try {
      return await this.db.tx(fn);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (isUniqueViolation(e, 'audit_legal_hold_event_once')) throw e;
      this.log.error(`audit_legal_hold_${what}_failed error=${e instanceof Error ? e.name : 'Error'} — nothing changed (fail closed; a fresh step-up is needed)`);
      throw httpError(503, 'accountability_unavailable', AUDIT_MESSAGES.accountabilityUnavailable);
    }
  }

  /** H6: the hold's own `audit_legal_hold.*` record, validated by the shared contract, in the hold's transaction. No proof, no token. */
  private async recordOwn(q: Queryable, action: 'audit_legal_hold.placed' | 'audit_legal_hold.released', owner: string, holdId: string, changes: Record<string, string>): Promise<void> {
    const eventId = randomUUID();
    const { rows } = await q.query<{ now: Date }>('SELECT now()');
    const correlation = getRequestContext()?.correlationId;
    const event = validateAuditEvent({
      id: eventId,
      name: `audit.${action}`,
      payload: {
        action, actor: { type: 'user', id: owner, userKind: 'owner' }, organizationId: null,
        resource: { type: 'audit_legal_hold', id: holdId }, outcome: 'succeeded', changes,
      },
      headers: {
        eventId, occurredAt: rows[0]!.now.toISOString(), source: SERVICE_NAME, version: 1,
        ...(correlation && CORRELATION.test(correlation) ? { correlationId: correlation } : {}),
      },
    });
    const out = await this.records.insertOnce(toNewAuditRecord(event), q);
    if (out.kind !== 'inserted') throw new Error('legal hold record not inserted'); // a fresh UUID: unreachable
  }
}

function strictBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid();
  return body as Record<string, unknown>;
}

function reason(v: unknown): string {
  if (typeof v !== 'string' || !REASON.test(v)) throw invalid();
  return v;
}

/** A step-up proof is Auth's id (a UUID); anything else is refused here, never sent to Auth. */
function proof(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v.toLowerCase())) throw httpError(403, 'step_up_required', AUDIT_MESSAGES.stepUpRequired);
  return v;
}

function instant(v: unknown): Date {
  if (typeof v !== 'string' || !INSTANT.test(v)) throw invalid();
  const d = new Date(v);
  const normalized = v.length === 20 ? `${v.slice(0, 19)}.000Z` : v;
  if (Number.isNaN(d.getTime()) || d.toISOString() !== normalized) throw invalid();
  return d;
}
