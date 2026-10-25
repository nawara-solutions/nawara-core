import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CentralAudit, ownerActor } from '../audit/central-audit.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { AuditActor } from '@nawara/audit-contract';
import { DbService, isUniqueViolation, pgCode, pgConstraint, provesNothingCommitted, type Queryable } from '../db/db.service.js';
import { REFUND_AUTHORIZE_PURPOSE, StepUpService } from '../owner/step-up.service.js';
import {
  bindingDigest, canonicalBinding, parseBinding, requestHash, secretDigest, type RefundBinding,
} from './receipt-binding.js';
import { ReceiptError, receiptError, type ReceiptErrorCode } from './receipt-errors.js';

/** F-3: a receipt lives 10 minutes (also a database CHECK; the SQL below writes the same interval). */
export const RECEIPT_LIFETIME_MS = 10 * 60 * 1000;
/** As Payment's `Idempotency-Key` (D-A2 §5.1; also a database CHECK). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** base64url of 32 random bytes, unpadded. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** A service name, as the service-token callers (also a database CHECK on `consumedBy`). */
const CALLER = /^[a-z][a-z0-9-]{0,62}$/;

/** The Owner who issues: a database-proven owner id and the live session it acts in (never request values). */
export interface ReceiptOwner { userId: string; sid: string }

export interface IssueReceiptInput { stepUpToken: string | undefined; idempotencyKey: string; binding: unknown }
/** The only place the plaintext secret ever exists in Auth: this return value, once. */
export interface IssuedReceipt { receiptId: string; secret: string; expiresAt: Date }

export interface ConsumeReceiptInput { secret: string; binding: unknown; consumeRef: string }
/** A consumption: the authorization's commit point (F-11). `approvedBy` is the issuer from Auth's own row, never a request value (F-16). */
export interface ReceiptConsumption { receiptId: string; consumeRef: string; consumedAt: Date; approvedBy: { userId: string }; companyId: string }

interface ReceiptRow {
  id: string; status: 'issued' | 'consumed' | 'voided'; requestHash: string; bindingDigest: string; expired: boolean;
  consumeRef: string | null; consumedBy: string | null; consumedAt: Date | null; issuerUserId: string;
}

/** A failed check constraint, by name (PostgreSQL `check_violation`). */
const isCheckViolation = (e: unknown, constraint: string) => pgCode(e) === '23514' && pgConstraint(e) === constraint;

/**
 * Authorization receipts (Core V2 S2-Auth.1 and S2-Auth.2; ADR-0067; D-A2 receipt contract). Reached only through
 * `AuthorizationReceiptController` (AUTH-01, the Owner's own bearer) and `ServiceAuthorizationReceiptController` (AUTH-02 and AUTH-03,
 * a service token admitted by `AUTH_SERVICE_POLICY`). The `caller` of `consume` and `lookupConsumption` is that token's caller, never a
 * request value.
 *
 * Clock (S2-Auth.2): the DATABASE clock (`clock_timestamp()`) is the only authority on a receipt's time, in issuance, replay,
 * consumption and recovery. `issuedAt` and `expiresAt` are written in one statement from one reading of it, and a consumption is
 * checked and stamped by the statement that commits it, so no application clock or skew between Auth instances can extend validity
 * (D-A2 §9). The `authorization_receipt_consumed_in_time` CHECK refuses any consumption stamped at or after `expiresAt`.
 *
 * Secret handling: the secret and the canonical binding are never stored, logged or audited; only HMAC digests under the dedicated
 * receipt pepper are stored (domain-separated: binding, secret, request). Without the pepper every method fails closed.
 */
@Injectable()
export class AuthorizationReceiptService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(StepUpService) private readonly stepUps: StepUpService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CentralAudit) private readonly central: CentralAudit,
  ) {}

  /**
   * Core V2 S2-Audit.2 (ADR-0067 decision 7; Owner decisions D1 to D5): the central audit intent of a receipt change, written by the kit
   * outbox writer ON THE SAME TRANSACTION as the change and its Auth-local record: both commit or neither. Delivery is the relay's, after
   * COMMIT, with its own durable retries, so a broker or Audit outage never rolls back a committed receipt. `companyId` is always Auth's
   * own Owner–Company row (never the request's binding); nothing secret travels: no secret, digest, proof, binding or amount.
   */
  private recordCentrally(q: Queryable, action: 'authorization_receipt.issued' | 'authorization_receipt.consumed' | 'authorization_receipt.voided',
    a: { receiptId: string; companyId: string; actor: AuditActor; approvedBy?: { userId: string } }) {
    // explicit literals (no spread): the outbox generates every event id (outbox retention safety, check:repo)
    const resource = { type: 'authorization_receipt', id: a.receiptId } as const;
    if (a.approvedBy) {
      return this.central.write(q, {
        action, actor: a.actor, organizationId: null, resource, outcome: 'succeeded', companyId: a.companyId,
        approvedBy: { type: 'user', id: a.approvedBy.userId, userKind: 'owner' },
      });
    }
    return this.central.write(q, { action, actor: a.actor, organizationId: null, resource, outcome: 'succeeded', companyId: a.companyId });
  }

  private pepper(): Buffer {
    const p = this.cfg.secrets.authorizationReceiptPepper;
    if (!p) throw receiptError('receipt_unavailable');
    return p;
  }

  /**
   * Issues a receipt to the active Owner of `binding.companyId`, after a factor-only refund-authorization step-up (F-1 to F-5). Order
   * (D-A2 §5.1): (1) a replay of the same key is answered first, so it never needs or burns a step-up; then ONE transaction (2) consumes
   * the step-up, (3) checks the Owner and the Company, (4) inserts the receipt and its audit record. A failure after (2) rolls the
   * consumption back: the proof is not burned. A concurrent duplicate with the same key loses on the (issuer, key) uniqueness and is
   * answered by the replay rules: it never receives a secret and never leaves a second valid receipt (F-5).
   *
   * Uncertain outcome: when the database cannot prove that nothing was committed, `receipt_outcome_unknown`. The Owner replays the same
   * key: the replay rules then answer from what actually committed (a lost response voids the receipt; nothing committed issues one).
   */
  async issue(owner: ReceiptOwner, input: IssueReceiptInput): Promise<IssuedReceipt> {
    const pepper = this.pepper();
    if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw receiptError('validation_error');
    const binding = parseBinding(input.binding);
    const canonical = canonicalBinding(binding);
    const reqHash = requestHash(pepper, canonical);

    await this.answerReplay(owner, input.idempotencyKey, reqHash); // throws for a replay; returns for a new key
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    try {
      return await this.db.tx(async (q) => {
        await this.stepUps.consume(q, { ownerId: owner.userId, sid: owner.sid, purpose: REFUND_AUTHORIZE_PURPOSE, token: input.stepUpToken });
        const { rows: o } = await q.query(
          `SELECT o."companyId"::text AS "companyId", u."isActive" FROM owner o JOIN "user" u ON u.id = o."userId" AND u.kind = 'owner'
            WHERE o."userId" = $1`,
          [owner.userId],
        );
        if (!o[0]?.isActive) throw receiptError('authority_revoked');
        if (o[0].companyId !== binding.companyId) throw receiptError('receipt_binding_invalid'); // F-2: only the Owner's own Company

        const { rows: ins } = await q.query<{ expiresAt: Date }>(
          `INSERT INTO authorization_receipt (id, "issuerUserId", "sessionFamilyId", "stepUpId", "idempotencyKey", "requestHash", "secretDigest",
             "bindingDigest", "issuedAt", "expiresAt")
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, c.t, c.t + interval '10 minutes' FROM (SELECT clock_timestamp() AS t) c
           RETURNING "expiresAt"`,
          [id, owner.userId, owner.sid, input.stepUpToken, input.idempotencyKey, reqHash, secretDigest(pepper, secret),
            bindingDigest(pepper, canonical)],
        );
        await this.audit.record({
          type: 'authorization_receipt.issued', outcome: 'success', actorId: owner.userId, targetId: id, sessionFamilyId: owner.sid,
          metadata: { companyId: binding.companyId },
        }, q);
        // the Company from Auth's own Owner row (`o[0]`, read in this transaction), equal to the binding's by the check above
        await this.recordCentrally(q, 'authorization_receipt.issued', { receiptId: id, companyId: o[0].companyId, actor: ownerActor(owner) });
        return { receiptId: id, secret, expiresAt: ins[0]!.expiresAt };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'authorization_receipt_idempotency_uk')) await this.answerReplay(owner, input.idempotencyKey, reqHash);
      throw this.classify(e);
    }
  }

  /**
   * The replay rules of an issue key (F-5, F-6; D-A2 §7.2; Q6). Throws the answer for a replay; returns only when the key is new. Never
   * returns a secret. An `issued` unexpired receipt is voided by one conditional statement (with its audit record); if it changed
   * meanwhile, the rules are applied again to what it became.
   */
  private async answerReplay(owner: ReceiptOwner, key: string, reqHash: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await this.db.query<ReceiptRow>(
        `SELECT id, status, "requestHash", "expiresAt" <= clock_timestamp() AS expired
           FROM authorization_receipt WHERE "issuerUserId" = $1 AND "idempotencyKey" = $2`,
        [owner.userId, key],
      );
      const r = rows[0];
      if (!r) return;
      if (r.requestHash !== reqHash) throw receiptError('idempotency_key_reused');
      if (r.status === 'consumed') throw receiptError('receipt_already_consumed');
      if (r.status === 'voided') throw receiptError('receipt_issued_response_lost');
      if (r.expired) throw receiptError('receipt_expired'); // Q6: deterministic, nothing restored or changed
      const voided = await this.db.tx(async (q) => {
        const { rows: v } = await q.query<{ id: string; companyId: string }>(
          `UPDATE authorization_receipt SET status = 'voided', "voidedAt" = clock_timestamp()
            WHERE id = $1 AND status = 'issued' AND "expiresAt" > clock_timestamp()
            RETURNING id, (SELECT o."companyId"::text FROM owner o WHERE o."userId" = authorization_receipt."issuerUserId") AS "companyId"`,
          [r.id],
        );
        if (!v[0]) return false;
        await this.audit.record({
          type: 'authorization_receipt.voided', outcome: 'success', actorId: owner.userId, targetId: r.id, sessionFamilyId: owner.sid,
        }, q);
        // D4: the void is the automatic F-5 replay rule, so its central actor is that process, never the Owner (the local record keeps who
        // sent the replaying request). The Company is the issuer's own Owner row.
        await this.recordCentrally(q, 'authorization_receipt.voided', {
          receiptId: r.id, companyId: v[0].companyId, actor: { type: 'system', id: 'authorization_receipt_replay' },
        });
        return true;
      });
      if (voided) throw receiptError('receipt_issued_response_lost');
    }
    throw receiptError('receipt_issued_response_lost'); // unreachable in practice: a terminal state is reached within one change
  }

  /**
   * Consumes a receipt for the authenticated service `caller` (F-7 to F-11, F-18). ONE conditional statement is the commit point: it
   * requires the matching secret and binding digests, status `issued`, an unexpired receipt and an issuer still active and still Owner
   * of the bound Company. Only when it matches nothing is the row read, to give the deterministic answer; no refusal changes anything.
   *
   * Outcomes the database cannot settle (D-A2 §10): a failure that PROVES nothing was committed is `receipt_unavailable` (the receipt
   * is unchanged; retrying is safe). Any other failure is uncertain: the consumption under `consumeRef` is looked up once and, when it
   * exists, returned (it really committed); otherwise `receipt_outcome_unknown`, never an invented success or failure. The caller then
   * retries with the SAME `consumeRef` (idempotent) or uses AUTH-03; a different `consumeRef` conflicts once the first one committed.
   */
  async consume(caller: string, input: ConsumeReceiptInput): Promise<ReceiptConsumption> {
    const pepper = this.pepper();
    if (typeof caller !== 'string' || !CALLER.test(caller)) throw receiptError('validation_error');
    if (typeof input.consumeRef !== 'string' || !UUID.test(input.consumeRef)) throw receiptError('validation_error');
    const binding = parseBinding(input.binding);
    if (binding.audience !== caller) throw receiptError('receipt_binding_invalid'); // F-7: only the bound audience
    if (typeof input.secret !== 'string' || !SECRET.test(input.secret)) return this.refuse('receipt_invalid', caller);
    const sDigest = secretDigest(pepper, input.secret);
    const bDigest = bindingDigest(pepper, canonicalBinding(binding));

    let consumed: ReceiptConsumption | undefined;
    try {
      consumed = await this.db.tx(async (q) => {
        const { rows } = await q.query<{ id: string; issuerUserId: string; consumedAt: Date; companyId: string }>(
          `UPDATE authorization_receipt r SET status = 'consumed', "consumedAt" = clock_timestamp(), "consumeRef" = $3, "consumedBy" = $4
            WHERE r."secretDigest" = $1 AND r."bindingDigest" = $2 AND r.status = 'issued' AND r."expiresAt" > clock_timestamp()
              AND EXISTS (SELECT 1 FROM owner o JOIN "user" u ON u.id = o."userId" AND u.kind = 'owner'
                           WHERE o."userId" = r."issuerUserId" AND o."companyId" = $5 AND u."isActive")
            RETURNING r.id, r."issuerUserId", r."consumedAt",
                      (SELECT o."companyId"::text FROM owner o WHERE o."userId" = r."issuerUserId") AS "companyId"`,
          [sDigest, bDigest, input.consumeRef, caller, binding.companyId],
        );
        const row = rows[0];
        if (!row) return undefined;
        await this.audit.record({
          type: 'authorization_receipt.consumed', outcome: 'success', actorId: null, targetId: row.id,
          metadata: { caller, companyId: binding.companyId, approvedBy: row.issuerUserId },
        }, q);
        // D4/D5: the authenticated service is the actor; the approver is the issuer this statement just proved an active Owner of the Company
        await this.recordCentrally(q, 'authorization_receipt.consumed', {
          receiptId: row.id, companyId: row.companyId, actor: { type: 'service', id: caller }, approvedBy: { userId: row.issuerUserId },
        });
        return this.consumption(row, input.consumeRef, binding);
      });
    } catch (e) {
      // F-18: this reference already consumed ANOTHER receipt.
      if (isUniqueViolation(e, 'authorization_receipt_consume_ref_uk')) return this.refuse('consume_ref_conflict', caller);
      // stamped at or after expiresAt by the statement itself (the boundary instant): refused by the CHECK, nothing changed
      if (isCheckViolation(e, 'authorization_receipt_consumed_in_time')) return this.refuse('receipt_expired', caller);
      if (provesNothingCommitted(e)) throw receiptError('receipt_unavailable');
      return this.recoverUncertain(caller, input.consumeRef, binding, bDigest);
    }
    if (consumed) return consumed;

    const { rows } = await this.db.query<ReceiptRow>(
      `SELECT id, status, "bindingDigest", "expiresAt" <= clock_timestamp() AS expired, "consumeRef"::text AS "consumeRef", "consumedBy",
              "consumedAt", "issuerUserId"
         FROM authorization_receipt WHERE "secretDigest" = $1`,
      [sDigest],
    );
    const r = rows[0];
    if (!r || r.bindingDigest !== bDigest || r.status === 'voided') return this.refuse('receipt_invalid', caller, r?.id);
    if (r.status === 'consumed') {
      // F-9: the identical repeat (same reference, same caller) is the original consumption; anything else conflicts.
      // a consumed row always has `consumedAt` (database CHECK authorization_receipt_state_pairing)
      if (r.consumeRef === input.consumeRef && r.consumedBy === caller) {
        return this.consumption({ id: r.id, issuerUserId: r.issuerUserId, consumedAt: r.consumedAt as Date }, input.consumeRef, binding);
      }
      return this.refuse('consume_ref_conflict', caller, r.id);
    }
    if (r.expired) return this.refuse('receipt_expired', caller, r.id);
    // issued, unexpired, matching: only the authority condition failed (F-11). Not consumed; it stays issued (Q7).
    return this.refuse('authority_revoked', caller, r.id);
  }

  /**
   * Recovery after a lost consumption response (F-10, F-14): the consumption under `consumeRef`, only for the caller that made it and
   * only for the same binding; anything else is indistinguishable from absence. No secret is needed or returned.
   */
  async lookupConsumption(caller: string, input: { consumeRef: string; binding: unknown }): Promise<ReceiptConsumption> {
    const pepper = this.pepper();
    if (typeof caller !== 'string' || !CALLER.test(caller)) throw receiptError('validation_error');
    if (typeof input.consumeRef !== 'string' || !UUID.test(input.consumeRef)) throw receiptError('validation_error');
    const binding = parseBinding(input.binding);
    const found = await this.findConsumption(caller, input.consumeRef, bindingDigest(pepper, canonicalBinding(binding)));
    if (!found) throw receiptError('not_found');
    return this.consumption(found, input.consumeRef, binding);
  }

  /** A read only: never consumes. The consumption under `consumeRef` by `caller` for exactly this binding digest. */
  private async findConsumption(caller: string, consumeRef: string, bDigest: string) {
    const { rows } = await this.db.query<{ id: string; issuerUserId: string; consumedAt: Date }>(
      `SELECT id, "issuerUserId", "consumedAt" FROM authorization_receipt
        WHERE "consumeRef" = $1 AND status = 'consumed' AND "consumedBy" = $2 AND "bindingDigest" = $3`,
      [consumeRef, caller, bDigest],
    );
    return rows[0];
  }

  /** After an uncertain consumption: what actually committed, or `receipt_outcome_unknown`. Never a second consumption. */
  private async recoverUncertain(caller: string, consumeRef: string, b: RefundBinding, bDigest: string): Promise<ReceiptConsumption> {
    const found = await this.findConsumption(caller, consumeRef, bDigest).catch(() => undefined);
    if (found) return this.consumption(found, consumeRef, b);
    throw receiptError('receipt_outcome_unknown');
  }

  /** Issue failures: typed and HTTP errors pass unchanged; a proven non-commit is `receipt_unavailable`; anything else is uncertain. */
  private classify(e: unknown): unknown {
    if (e instanceof ReceiptError || typeof (e as { getStatus?: unknown })?.getStatus === 'function') return e;
    return receiptError(provesNothingCommitted(e) ? 'receipt_unavailable' : 'receipt_outcome_unknown');
  }

  private consumption(row: { id: string; issuerUserId: string; consumedAt: Date }, consumeRef: string, b: RefundBinding): ReceiptConsumption {
    return { receiptId: row.id, consumeRef, consumedAt: row.consumedAt, approvedBy: { userId: row.issuerUserId }, companyId: b.companyId };
  }

  /** A refused consumption: a local denial record (no secret, binding or digest), then the typed error. Nothing changes. */
  private async refuse(code: ReceiptErrorCode, caller: string, receiptId?: string): Promise<never> {
    await this.audit.tryRecord({
      type: 'authorization_receipt.consumed', outcome: 'denied', actorId: null, targetId: receiptId ?? null, metadata: { caller, reason: code },
    });
    throw receiptError(code);
  }
}
