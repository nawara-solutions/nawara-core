import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, getRequestContext, type AuthIdentity, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import { notFound, operationNotPermitted, paymentError } from '../errors.js';
import type { EventContext } from '../events/payment-events.js';
import { PAYMENT_MESSAGES } from '../messages.js';
import { RECEIPT_AUTHORITY, type ReceiptAuthority, type ReceiptConsumption } from '../refunds/receipt-authority.js';
import { receiptDigest, type DisputeDecisionBinding } from '../refunds/refund.types.js';
import { DISPUTE_EVIDENCE_FILES, type DisputeEvidenceFiles } from './dispute-evidence-files.js';
import type { DisputeRow } from './dispute.types.js';
import { OWNER_COMPANY_AUTHORITY, type OwnerCompanyAuthority, type VerifiedOwner } from './owner-company.authority.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
/** An Auth receipt secret: base64url of 32 bytes (AUTH-01). */
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const STATUSES = new Set(['open', 'won', 'lost']);

/** A `payment_dispute_decision` row (migration 0019). */
export interface DisputeDecisionRow {
  id: string;
  disputeId: string;
  decision: 'contest' | 'accept';
  companyId: string;
  requestedByUserId: string;
  idempotencyKey: string;
  receiptDigest: string;
  status: 'authorization_pending' | 'recorded' | 'authorization_refused' | 'authorization_expired';
  receiptId: string | null;
  approvedByUserId: string | null;
  refusal: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
}

export interface DisputeEvidenceRow {
  id: string;
  disputeId: string;
  grantId: string;
  fileId: string;
  addedByUserId: string;
  addedAt: Date;
}

type ScopedDispute = DisputeRow & { organizationId: string | null; paymentRequestId: string; producer: string };

const invalidRequest = () => paymentError(400, 'invalid_dispute_request', PAYMENT_MESSAGES.invalidDisputeRequest);
const notOpen = () => paymentError(409, 'dispute_not_open', PAYMENT_MESSAGES.disputeNotOpen);

/**
 * Core V2 S6e-D (register PAY-09 to PAY-11; S0 §1.1, §3.10; the Owner's R6E-3, R6E-8). DEVELOPMENT AND SIMULATION ONLY. The Owner of the
 * payment's seller Company, verified LIVE through Auth on every request (`OwnerCompanyAuthority`), reads that Company's disputes, adds evidence
 * references and records the contest-or-accept decision. Another Company's dispute is the same `404` as an unknown one.
 *
 * The decision (PAY-11) is authorized ONLY by an Auth `dispute_decision` receipt (issued after the dedicated factor-only dispute-decision
 * step-up) bound to exactly this Company, dispute, payment and decision, consumed by Payment with its own service token. ADR-0067's order:
 * (1) the durable intent (its id is the receipt `consumeRef`), (2) the consumption at Auth, (3) `recorded` with Auth's approver. Only Auth's
 * definitive answers end an intent (`receipt_invalid`, `receipt_binding_invalid` → refused; `receipt_expired` → expired); anything else leaves
 * it pending: the Owner repeats the same request (same key, same receipt) and Payment resumes it. A decision never changes the dispute's
 * state: the provider alone decides `won` or `lost`.
 */
@Injectable()
export class DisputeOwnerService {
  private readonly log = new Logger('PaymentDisputeOwner');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
    @Inject(RECEIPT_AUTHORITY) private readonly receipts: ReceiptAuthority,
    @Inject(OWNER_COMPANY_AUTHORITY) private readonly owners: OwnerCompanyAuthority,
    @Inject(DISPUTE_EVIDENCE_FILES) private readonly files: DisputeEvidenceFiles,
  ) {}

  /** The live Owner check: Auth's `/auth/me` (the guard, this request) says Owner, and `/auth/grants` names the same user and their Company. */
  async owner(bearer: string, identity: AuthIdentity): Promise<VerifiedOwner> {
    if (identity.adminTier !== 'owner') throw operationNotPermitted();
    const o = await this.owners.owner(bearer, AbortSignal.timeout(this.config.authTimeoutMs));
    if (!o || o.userId !== identity.id.toLowerCase()) throw operationNotPermitted();
    return o;
  }

  /** PAY-09: the Company's disputes, newest first. */
  async list(owner: VerifiedOwner, status: string | undefined, limit: number): Promise<ScopedDispute[]> {
    if (status !== undefined && !STATUSES.has(status)) throw invalidRequest();
    const { rows } = await this.db.query<ScopedDispute>(
      `SELECT d.*, p."organizationId", p."paymentRequestId", p.producer FROM payment_dispute d JOIN payment p ON p.id = d."paymentId"
        WHERE p."sellerType" = 'company' AND p."sellerId" = $1 AND ($2::text IS NULL OR d.status = $2) ORDER BY d."recordedAt" DESC, d.id LIMIT $3`,
      [owner.companyId, status ?? null, limit],
    );
    return rows;
  }

  /** PAY-09: one dispute of the Company, with its chargeback fact, observations, evidence and decisions. */
  async get(owner: VerifiedOwner, id: string) {
    const d = await this.scoped(this.db, owner, id);
    const [chargeback, observations, evidence, decisions] = await Promise.all([
      d.chargebackFactId
        ? this.db.query<{ id: string; providerTxnId: string; amount: string; currency: string; observedAt: Date }>(
          `SELECT id, "providerTxnId", amount, currency, "observedAt" FROM provider_transaction_fact WHERE id = $1`, [d.chargebackFactId]).then((r) => r.rows[0] ?? null)
        : Promise.resolve(null),
      this.db.query<{ kind: string; disposition: string; reason: string | null; observedAt: Date }>(
        `SELECT kind, disposition, reason, "observedAt" FROM payment_dispute_observation WHERE "disputeId" = $1 ORDER BY "observedAt", id`, [d.id]).then((r) => r.rows),
      this.db.query<DisputeEvidenceRow>(`SELECT * FROM payment_dispute_evidence WHERE "disputeId" = $1 ORDER BY "addedAt", id`, [d.id]).then((r) => r.rows),
      this.db.query<DisputeDecisionRow>(`SELECT * FROM payment_dispute_decision WHERE "disputeId" = $1 ORDER BY "requestedAt", id`, [d.id]).then((r) => r.rows),
    ]);
    return { dispute: d, chargeback, observations, evidence, decisions };
  }

  /**
   * PAY-10: an append-only evidence reference, while the dispute is open. File must answer, live, that the grant names Payment, this file and
   * exactly this dispute as its `dispute_evidence` case; nothing else is recorded. The same file again answers the existing reference.
   */
  async addEvidence(owner: VerifiedOwner, id: string, input: { grantId?: unknown; fileId?: unknown }): Promise<{ evidence: DisputeEvidenceRow; created: boolean }> {
    const grantId = typeof input.grantId === 'string' ? input.grantId.toLowerCase() : '';
    const fileId = typeof input.fileId === 'string' ? input.fileId.toLowerCase() : '';
    if (!UUID.test(grantId) || !UUID.test(fileId)) throw invalidRequest();
    const d = await this.scoped(this.db, owner, id);
    const existing = await this.evidenceOf(this.db, d.id, fileId);
    if (existing) return { evidence: existing, created: false };
    if (d.status !== 'open') throw notOpen();
    let granted;
    try {
      granted = await this.files.granted(grantId, fileId, AbortSignal.timeout(this.config.authTimeoutMs));
    } catch {
      throw paymentError(503, 'dispute_evidence_unavailable', PAYMENT_MESSAGES.disputeEvidenceUnavailable);
    }
    if (!granted || granted.grantId !== grantId || granted.fileId !== fileId || granted.purpose !== 'dispute_evidence' || granted.caseRef !== d.id) {
      throw paymentError(422, 'dispute_evidence_invalid', PAYMENT_MESSAGES.disputeEvidenceInvalid);
    }
    return this.db.tx(async (q) => {
      const locked = await this.scoped(q, owner, id, true);
      const raced = await this.evidenceOf(q, d.id, fileId);
      if (raced) return { evidence: raced, created: false };
      if (locked.status !== 'open') throw notOpen();
      const evidence = (await q.query<DisputeEvidenceRow>(
        `INSERT INTO payment_dispute_evidence ("disputeId", "grantId", "fileId", "addedByUserId") VALUES ($1, $2, $3, $4) RETURNING *`,
        [d.id, grantId, fileId, owner.userId])).rows[0]!;
      await this.audit.recordDispute(q, 'payment_dispute.evidence_added', d, d.organizationId, this.ownerContext(owner), { fileId, grantId }, evidence.id);
      return { evidence, created: true };
    });
  }

  /** PAY-11: the Owner's decision, authorized by a consumed `dispute_decision` receipt. */
  async decide(owner: VerifiedOwner, id: string, key: string | undefined, input: { decision?: unknown; receiptSecret?: unknown }): Promise<{ decision: DisputeDecisionRow; created: boolean }> {
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) throw paymentError(400, 'idempotency_key_required', PAYMENT_MESSAGES.idempotencyKeyRequired);
    if ((input.decision !== 'contest' && input.decision !== 'accept') || typeof input.receiptSecret !== 'string' || !SECRET.test(input.receiptSecret)) throw invalidRequest();
    const decision = input.decision;
    const secret = input.receiptSecret;
    const digest = receiptDigest(secret);

    // (1) the durable intent, or the one this key already names
    const { intent, paymentId, created } = await this.db.tx(async (q) => {
      const d = await this.scoped(q, owner, id, true);
      const byKey = (await q.query<DisputeDecisionRow>(
        `SELECT * FROM payment_dispute_decision WHERE "requestedByUserId" = $1 AND "idempotencyKey" = $2`, [owner.userId, key])).rows[0];
      if (byKey) {
        if (byKey.disputeId !== d.id || byKey.decision !== decision) throw paymentError(422, 'idempotency_key_reused', PAYMENT_MESSAGES.idempotencyKeyReused);
        if (byKey.receiptDigest !== digest) throw paymentError(409, 'dispute_decision_conflict', PAYMENT_MESSAGES.disputeDecisionConflict);
        return { intent: byKey, paymentId: d.paymentId, created: false };
      }
      if (d.status !== 'open') throw notOpen();
      if ((await q.query(`SELECT 1 FROM payment_dispute_decision WHERE "disputeId" = $1 AND status IN ('authorization_pending', 'recorded')`, [d.id])).rows.length > 0) {
        throw paymentError(409, 'dispute_decision_exists', PAYMENT_MESSAGES.disputeDecisionExists);
      }
      const row = (await q.query<DisputeDecisionRow>(
        `INSERT INTO payment_dispute_decision (id, "disputeId", decision, "companyId", "requestedByUserId", "idempotencyKey", "receiptDigest")
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [randomUUID(), d.id, decision, owner.companyId, owner.userId, key, digest])).rows[0]!;
      return { intent: row, paymentId: d.paymentId, created: true };
    });
    if (intent.status === 'recorded') return { decision: intent, created: false };
    if (intent.status !== 'authorization_pending') throw this.refusedError();

    // (2) Auth consumes the receipt for exactly this binding, under the intent's id
    const binding: DisputeDecisionBinding = { operation: 'dispute_decision', audience: 'payment-service', companyId: owner.companyId, disputeId: intent.disputeId, paymentId, decision };
    let out = await this.receipts.consume({ secret, binding, consumeRef: intent.id });
    if (out.kind === 'conflict' || out.kind === 'unresolved') {
      const found = await this.receipts.lookup({ binding, consumeRef: intent.id }); // a consumption whose answer was lost
      if (found.kind === 'consumed') out = found;
    }
    // (3) the outcome Auth's answer proves; anything else leaves the intent pending (retry the same request)
    if (out.kind === 'consumed') return { decision: await this.record(intent, out.consumption, owner), created };
    if (out.kind === 'refused' || out.kind === 'expired') {
      await this.db.query(
        `UPDATE payment_dispute_decision SET status = $2, refusal = $3 WHERE id = $1 AND status = 'authorization_pending'`,
        [intent.id, out.kind === 'expired' ? 'authorization_expired' : 'authorization_refused', out.kind === 'expired' ? 'receipt_expired' : out.code]);
      this.log.warn(`dispute_decision_refused decision=${intent.id} dispute=${intent.disputeId} reason=${out.kind === 'expired' ? 'receipt_expired' : out.code}`);
      throw this.refusedError();
    }
    this.log.warn(`dispute_decision_unresolved decision=${intent.id} dispute=${intent.disputeId} — the same request resumes it`);
    throw paymentError(503, 'dispute_decision_unresolved', PAYMENT_MESSAGES.disputeDecisionUnresolved);
  }

  private async record(intent: DisputeDecisionRow, c: ReceiptConsumption, owner: VerifiedOwner): Promise<DisputeDecisionRow> {
    return this.db.tx(async (q) => {
      // the approver is Auth's issuer of the receipt: it must be the Owner who asks (one Company, one Owner; anything else is refused, kept)
      if (c.approvedByUserId.toLowerCase() !== owner.userId) {
        await q.query(`UPDATE payment_dispute_decision SET status = 'authorization_refused', refusal = 'approver_mismatch' WHERE id = $1 AND status = 'authorization_pending'`, [intent.id]);
        throw this.refusedError();
      }
      const row = (await q.query<DisputeDecisionRow>(
        `UPDATE payment_dispute_decision SET status = 'recorded', "receiptId" = $2, "approvedByUserId" = $3 WHERE id = $1 AND status = 'authorization_pending' RETURNING *`,
        [intent.id, c.receiptId, c.approvedByUserId])).rows[0];
      if (!row) return (await q.query<DisputeDecisionRow>(`SELECT * FROM payment_dispute_decision WHERE id = $1`, [intent.id])).rows[0]!; // a concurrent repeat recorded it
      const d = (await q.query<{ paymentId: string; organizationId: string | null }>(
        `SELECT d."paymentId", p."organizationId" FROM payment_dispute d JOIN payment p ON p.id = d."paymentId" WHERE d.id = $1`, [intent.disputeId])).rows[0]!;
      await this.audit.recordDispute(q, 'payment_dispute.decided', { id: intent.disputeId, paymentId: d.paymentId }, d.organizationId, this.ownerContext(owner),
        { decision: intent.decision }, intent.id);
      this.log.log(`dispute_decision_recorded decision=${intent.id} dispute=${intent.disputeId} decision=${intent.decision}`);
      return row;
    });
  }

  private refusedError() {
    return paymentError(409, 'dispute_decision_refused', PAYMENT_MESSAGES.disputeDecisionRefused);
  }

  private ownerContext(owner: VerifiedOwner): EventContext {
    return { actor: { type: 'user', id: owner.userId }, cause: { type: 'request', id: getRequestContext()?.requestId ?? null }, userKind: 'owner' };
  }

  private async evidenceOf(q: Queryable, disputeId: string, fileId: string): Promise<DisputeEvidenceRow | undefined> {
    return (await q.query<DisputeEvidenceRow>(`SELECT * FROM payment_dispute_evidence WHERE "disputeId" = $1 AND "fileId" = $2`, [disputeId, fileId])).rows[0];
  }

  /** One dispute of the Owner's Company (the payment's seller), or the collapsed 404. */
  private async scoped(q: Queryable, owner: VerifiedOwner, id: string, lock = false): Promise<ScopedDispute> {
    if (!UUID.test(id)) throw notFound();
    const { rows } = await q.query<ScopedDispute>(
      `SELECT d.*, p."organizationId", p."paymentRequestId", p.producer FROM payment_dispute d JOIN payment p ON p.id = d."paymentId"
        WHERE d.id = $1 AND p."sellerType" = 'company' AND p."sellerId" = $2${lock ? ' FOR UPDATE OF d' : ''}`,
      [id, owner.companyId],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }
}
