import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DbService, isUniqueViolation } from '../db/db.service.js';
import { REFUND_AUTHORIZE_PURPOSE, StepUpService } from '../owner/step-up.service.js';
import {
  bindingDigest, canonicalBinding, parseBinding, requestHash, secretDigest, type RefundBinding,
} from './receipt-binding.js';
import { receiptError, type ReceiptErrorCode } from './receipt-errors.js';

/** F-3: a receipt lives 10 minutes (also a database CHECK). */
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
  id: string; status: 'issued' | 'consumed' | 'voided'; requestHash: string; bindingDigest: string; expiresAt: Date;
  consumeRef: string | null; consumedBy: string | null; consumedAt: Date | null; issuerUserId: string;
}

/**
 * Authorization receipts (Core V2 S2-Auth.1; ADR-0067; D-A2 receipt contract): the internal domain only. NO route calls this service
 * in S2-Auth.1; S2-Auth.2 adds the Owner's issue route and the service-token consumption and lookup routes behind
 * `AUTH_SERVICE_POLICY`. The `caller` of `consume` and `lookupConsumption` must therefore come from an authenticated service token.
 *
 * Secret handling: the secret and the canonical binding are never stored, logged or audited; only HMAC digests under the dedicated
 * receipt pepper are stored (domain-separated: binding, secret, request). Without the pepper every method fails closed.
 */
@Injectable()
export class AuthorizationReceiptService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(StepUpService) private readonly stepUps: StepUpService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

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
   * answered by the replay rules.
   */
  async issue(owner: ReceiptOwner, input: IssueReceiptInput): Promise<IssuedReceipt> {
    const pepper = this.pepper();
    if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw receiptError('validation_error');
    const binding = parseBinding(input.binding);
    const canonical = canonicalBinding(binding);
    const reqHash = requestHash(pepper, canonical);

    await this.answerReplay(owner, input.idempotencyKey, reqHash); // throws for a replay; returns for a new key
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

        const id = randomUUID();
        const secret = randomBytes(32).toString('base64url');
        const issuedAt = this.clock.now();
        const expiresAt = new Date(issuedAt.getTime() + RECEIPT_LIFETIME_MS);
        await q.query(
          `INSERT INTO authorization_receipt (id, "issuerUserId", "sessionFamilyId", "stepUpId", "idempotencyKey", "requestHash", "secretDigest",
             "bindingDigest", "issuedAt", "expiresAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, owner.userId, owner.sid, input.stepUpToken, input.idempotencyKey, reqHash, secretDigest(pepper, secret),
            bindingDigest(pepper, canonical), issuedAt, expiresAt],
        );
        await this.audit.record({
          type: 'authorization_receipt.issued', outcome: 'success', actorId: owner.userId, targetId: id, sessionFamilyId: owner.sid,
          metadata: { companyId: binding.companyId },
        }, q);
        return { receiptId: id, secret, expiresAt };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'authorization_receipt_idempotency_uk')) await this.answerReplay(owner, input.idempotencyKey, reqHash);
      throw e;
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
        `SELECT id, status, "requestHash", "expiresAt" FROM authorization_receipt WHERE "issuerUserId" = $1 AND "idempotencyKey" = $2`,
        [owner.userId, key],
      );
      const r = rows[0];
      if (!r) return;
      if (r.requestHash !== reqHash) throw receiptError('idempotency_key_reused');
      if (r.status === 'consumed') throw receiptError('receipt_already_consumed');
      if (r.status === 'voided') throw receiptError('receipt_issued_response_lost');
      const now = this.clock.now();
      if (r.expiresAt.getTime() <= now.getTime()) throw receiptError('receipt_expired'); // Q6: deterministic, nothing restored or changed
      const voided = await this.db.tx(async (q) => {
        const { rows: v } = await q.query(
          `UPDATE authorization_receipt SET status = 'voided', "voidedAt" = $2 WHERE id = $1 AND status = 'issued' AND "expiresAt" > $2 RETURNING id`,
          [r.id, now],
        );
        if (!v[0]) return false;
        await this.audit.record({
          type: 'authorization_receipt.voided', outcome: 'success', actorId: owner.userId, targetId: r.id, sessionFamilyId: owner.sid,
        }, q);
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
    const now = this.clock.now();

    let consumed: ReceiptConsumption | undefined;
    try {
      consumed = await this.db.tx(async (q) => {
        const { rows } = await q.query<{ id: string; issuerUserId: string; consumedAt: Date }>(
          `UPDATE authorization_receipt r SET status = 'consumed', "consumedAt" = $3, "consumeRef" = $4, "consumedBy" = $5
            WHERE r."secretDigest" = $1 AND r."bindingDigest" = $2 AND r.status = 'issued' AND r."expiresAt" > $3
              AND EXISTS (SELECT 1 FROM owner o JOIN "user" u ON u.id = o."userId" AND u.kind = 'owner'
                           WHERE o."userId" = r."issuerUserId" AND o."companyId" = $6 AND u."isActive")
            RETURNING r.id, r."issuerUserId", r."consumedAt"`,
          [sDigest, bDigest, now, input.consumeRef, caller, binding.companyId],
        );
        const row = rows[0];
        if (!row) return undefined;
        await this.audit.record({
          type: 'authorization_receipt.consumed', outcome: 'success', actorId: null, targetId: row.id,
          metadata: { caller, companyId: binding.companyId, approvedBy: row.issuerUserId },
        }, q);
        return this.consumption(row, input.consumeRef, binding);
      });
    } catch (e) {
      // F-18: this reference already consumed ANOTHER receipt.
      if (isUniqueViolation(e, 'authorization_receipt_consume_ref_uk')) return this.refuse('consume_ref_conflict', caller);
      throw e;
    }
    if (consumed) return consumed;

    const { rows } = await this.db.query<ReceiptRow>(
      `SELECT id, status, "bindingDigest", "expiresAt", "consumeRef"::text AS "consumeRef", "consumedBy", "consumedAt", "issuerUserId"
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
    if (r.expiresAt.getTime() <= now.getTime()) return this.refuse('receipt_expired', caller, r.id);
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
    const { rows } = await this.db.query<{ id: string; issuerUserId: string; consumedAt: Date }>(
      `SELECT id, "issuerUserId", "consumedAt" FROM authorization_receipt
        WHERE "consumeRef" = $1 AND status = 'consumed' AND "consumedBy" = $2 AND "bindingDigest" = $3`,
      [input.consumeRef, caller, bindingDigest(pepper, canonicalBinding(binding))],
    );
    if (!rows[0]) throw receiptError('not_found');
    return this.consumption(rows[0], input.consumeRef, binding);
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
