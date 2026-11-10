import { correlationHeaders } from '@nawara/service-kit';

/** DI token of Billing's refund port to payment-service (Core V2 S6b; PAY-07, PAY-08). */
export const PAYMENT_REFUND_CLIENT = Symbol('BILLING_PAYMENT_REFUND_CLIENT');

/** Payment's authoritative refund attempt states (payment migration 0017). */
export const ATTEMPT_STATUSES = ['authorization_pending', 'authorized', 'authorization_expired', 'authorization_refused', 'dispatching', 'submitted', 'succeeded',
  'failed', 'unknown', 'discrepancy'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
/** Payment's permanent refusals of a refund attempt id before any attempt existed. */
export const PAYMENT_REFUSALS = ['payment_not_refundable', 'refund_capture_unverified', 'refund_amount_not_full', 'refund_dispute_open', 'refund_in_progress',
  'refund_already_recorded', 'refund_case_completed', 'refund_capture_not_eligible'] as const; // Core V2 S6c: refund_case_completed (FC-3); R6H-5
export type PaymentRefusal = (typeof PAYMENT_REFUSALS)[number];

export interface RefundAttemptSnapshot {
  refundAttemptId: string;
  status: AttemptStatus;
  approvedBy: { userId: string } | null;
}

/** PAY-07's body. The secret is relayed in memory for this call only (F-12): never stored, logged or hashed. */
export interface RefundRelayBody {
  refundAttemptId: string;
  refundCaseId: string;
  amount: number;
  currency: string;
  reason: string;
  legalOverride: boolean;
  receiptSecret: string;
  /** Core V2 R6H-5: present exactly for a capture-specific case (the Owner's receipt names the same capture) */
  captureFactId?: string;
}

/** Core V2 R6H-5: Payment's evidence of one verified capture of a payment (`GET /payment/payments/:id/captures/:factId`). */
export type CaptureBasis = 'settling_capture' | 'duplicate_capture' | 'other_attempt_capture' | 'late_capture' | 'associated_capture';
export interface PaymentCapture {
  factId: string;
  paymentId: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  basis: CaptureBasis;
  conflicted: boolean;
  refund: 'none' | 'in_progress' | 'refunded';
  /** S6 certification: false when Payment would refuse to refund this capture on its own (the last capture backing the sale) */
  refundableOnItsOwn: boolean;
  /** S0-C12 item 14: the capture facts Payment holds on this fact's attempt (0: an associated fact, no attempt). More than one: the attempt is ambiguous. */
  attemptCaptures: number;
}
/**
 * Which `404` Payment's R6H-5 capture read answered (BIL-32 M): `capture_not_found` (Payment states the named fact is not a capture of that
 * payment), `collapsed` (`not_found`: an unknown payment, or one Payment does not hold as the caller's), `unrecognized` (any other 404 body).
 * The production client always states it; consumers that read only `kind` (capture-specific refund cases, item 8 contradiction cases) keep
 * their own approved meaning of `not_found`.
 */
export type CaptureNotFoundReason = 'capture_not_found' | 'collapsed' | 'unrecognized';
/**
 * What Payment's capture read proves: the capture; that this payment has no such capture (404); or (S0-C12 item 17) that this very fact is well-formed
 * in a 1 to 16 character currency no ISO shape holds, carrying no figures and no currency value. Anything else proves nothing.
 */
export type CaptureReadOutcome = { kind: 'capture'; capture: PaymentCapture } | { kind: 'not_found'; reason?: CaptureNotFoundReason } | { kind: 'ineligible_currency' }
  | { kind: 'unknown'; reason: string };
const CAPTURE_BASES: readonly string[] = ['settling_capture', 'duplicate_capture', 'other_attempt_capture', 'late_capture', 'associated_capture'];
const CAPTURE_REFUND: readonly string[] = ['none', 'in_progress', 'refunded'];
/**
 * S0-C12 item 14: a count that can be true of its basis. An associated fact has no attempt (0); a settling capture is its attempt's single fact (1); a
 * duplicate has a sibling (2 or more); any other basis names an attempt holding at least itself. Anything else is inconsistent and proves nothing.
 */
const consistentCaptureCount = (n: unknown, basis: string): boolean => typeof n === 'number' && Number.isSafeInteger(n)
  && (basis === 'associated_capture' ? n === 0 : basis === 'settling_capture' ? n === 1 : basis === 'duplicate_capture' ? n >= 2 : n >= 1);

/**
 * What Payment's answer to PAY-07 PROVES (R6B-10), classified once here:
 *   - `attempt`: the attempt exists in this authoritative state;
 *   - `terminal`: the attempt's authorization ended (Auth's definitive refusal or expiry, committed by Payment);
 *   - `refused`: Payment permanently refused this attempt id before any attempt existed;
 *   - `pending`: the attempt exists and its authorization is not confirmed yet (retry with the same key and receipt);
 *   - `conflict`: this attempt id is bound to other content or another receipt;
 *   - `unknown`: nothing is proven (a timeout, a lost connection, a 5xx, an auth fault, an unparseable answer): never read as a refusal.
 */
export type RefundRelayOutcome =
  | { kind: 'attempt'; attempt: RefundAttemptSnapshot }
  | { kind: 'terminal'; status: 'authorization_refused' | 'authorization_expired' }
  | { kind: 'refused'; code: PaymentRefusal }
  | { kind: 'pending' }
  | { kind: 'conflict' }
  | { kind: 'unknown'; reason: string };

/** Core V2 S6c (R6C-12): one of Payment's refund authorizations, with its financial completion (null until complete). */
export interface RefundAuthorizationSnapshot {
  refundAuthorizationId: string;
  refundAttemptId: string;
  refundCaseId: string;
  approvedAmount: number;
  currency: string;
  completedAt: string | null;
  /** Core V2 S0-C14 item 6: Payment's verified allocations of refund facts to this authorization (refund evidence). Absent from an older Payment: none */
  allocations: { factId: string; amount: number; currency: string }[];
}

/** Core V2 S0-C14 item 6: a refund fact Payment holds but has not allocated (pending or blocked): refund evidence all the same. */
/**
 * Core V2 DO-73: `blockedReason` is Payment's reason for a blocked fact (`null` while pending). `undefined` when Payment's answer does not carry it (or not a
 * bounded code): that proves nothing about the block's reason, and DO-73 then opens nothing.
 */
export interface UnallocatedRefundFact { factId: string; refundAttemptId: string | null; amount: number; currency: string; state: 'pending' | 'blocked'; blockedReason?: string | null }

export interface PaymentRefunds {
  attempts: RefundAttemptSnapshot[];
  refusals: { refundAttemptId: string; code: PaymentRefusal }[];
  authorizations: RefundAuthorizationSnapshot[];
  /**
   * Core V2 S0-C14 item 6: the producer's view of the refund facts not (yet) allocated. `null` when Payment's answer does not carry the field
   * (a non-producer view, or a Payment older than S6c): the answer then proves nothing about refund evidence, and callers fail closed.
   */
  unallocatedFacts: UnallocatedRefundFact[] | null;
  /**
   * Core V2 DO-74 (observer side): per refund attempt of this payment, its own observations that contradict a refund fact which is not this payment's.
   * `null` when Payment's answer does not carry the field (a non-producer view, or a Payment older than DO-74): it proves nothing. `'malformed'` when it is
   * present but unusable: also proves nothing, and only this field is discarded (S0-C14 and every other reader keep the rest of the answer unchanged).
   */
  observationConflicts?: ObservationConflict[] | 'malformed' | null;
  /**
   * Core V2 R3 (PAY-08 I): per FAILED refund attempt of this payment, what Payment can state about refund evidence left after the failure. `null` when
   * absent (a non-producer view, or a Payment older than R3), `'malformed'` when present but unusable: both prove nothing, and S0-C14 treats a failed attempt
   * of the movement as not clean. Parsed on its own: a bad field never turns the rest of the answer unavailable.
   */
  failedAttemptEvidence?: FailedAttemptEvidence[] | 'malformed' | null;
}

export const FAILED_ATTEMPT_EVIDENCE_STATES = ['unmatched_fact', 'notification_pending', 'none', 'unknown'] as const;
export type FailedAttemptEvidenceState = (typeof FAILED_ATTEMPT_EVIDENCE_STATES)[number];
export interface FailedAttemptEvidence {
  refundAttemptId: string;
  state: FailedAttemptEvidenceState;
}

/** Core V2 DO-74: the observing payment's own rows only: its attempt, its own conflict (observation) ids and their count. Nothing of the fact. */
export interface ObservationConflict { refundAttemptId: string; conflictIds: string[]; observations: number }

/** Core V2 S0-C11 item 7c (PAY-16): a payment's settling capture, as Payment's committed records state it. */
export interface SettlingCapture { paymentId: string; attemptId: string; factId: string; amount: number; currency: string; conflicted: boolean }
/**
 * What PAY-16 PROVES: the settling capture; `none` (`404 settling_capture_not_found`: Payment states this payment has none: not succeeded, no
 * succeeded attempt, or no fact); `ambiguous` (more than one capture fact on the succeeded attempt); anything else proves nothing (`unknown`).
 * BIL-32 L (C-2): the collapsed `404 not_found` is `unknown`, never `none`: Billing names the payment from its own payment request, so that answer
 * (Billing without `payment.read`, a payment Payment does not hold as Billing's, a malformed id) is a configuration or consistency fault, not
 * absent evidence.
 */
export type SettlingCaptureOutcome = { kind: 'capture'; capture: SettlingCapture } | { kind: 'none'; reason: string } | { kind: 'ambiguous' }
  | { kind: 'unknown'; reason: string };

export interface PaymentRefundClient {
  relay(paymentId: string, idempotencyKey: string, body: RefundRelayBody): Promise<RefundRelayOutcome>;
  /** PAY-08: null on 404; throws when Payment cannot answer (the reconciler isolates it per relay). */
  refunds(paymentId: string): Promise<PaymentRefunds | null>;
  /** Core V2 R6H-5: one verified capture of the payment, as Payment's evidence states it */
  capture(paymentId: string, factId: string): Promise<CaptureReadOutcome>;
  /** Core V2 S0-C11 item 7c (PAY-16): the payment's settling capture; it names no fact: Payment derives it */
  settlingCapture(paymentId: string): Promise<SettlingCaptureOutcome>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function snapshot(v: unknown): RefundAttemptSnapshot | null {
  const a = v as { refundAttemptId?: unknown; status?: unknown; approvedBy?: { userId?: unknown } | null } | null;
  if (!a || typeof a.refundAttemptId !== 'string' || !UUID.test(a.refundAttemptId) || !(ATTEMPT_STATUSES as readonly unknown[]).includes(a.status)) return null;
  const approvedBy = typeof a.approvedBy?.userId === 'string' ? { userId: a.approvedBy.userId } : null;
  return { refundAttemptId: a.refundAttemptId, status: a.status as AttemptStatus, approvedBy };
}

/** Billing's OWN service token only (ADR-0033); an Owner's bearer is never forwarded to Payment. */
export class HttpPaymentRefundClient implements PaymentRefundClient {
  constructor(private readonly opts: { baseUrl: string; serviceToken: string; timeoutMs: number }) {}

  private async call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.serviceToken}`, 'content-type': 'application/json', ...correlationHeaders(), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch {
      return { status: 0, body: null };
    }
    try {
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } catch {
      return { status: res.status, body: null };
    }
  }

  async relay(paymentId: string, idempotencyKey: string, body: RefundRelayBody): Promise<RefundRelayOutcome> {
    const r = await this.call('POST', `/payment/payments/${encodeURIComponent(paymentId)}/refunds`, { 'idempotency-key': idempotencyKey }, body);
    const code = typeof r.body?.code === 'string' ? r.body.code : null;
    if (r.status === 200 || r.status === 201) {
      const a = snapshot(r.body);
      return a && a.refundAttemptId === body.refundAttemptId ? { kind: 'attempt', attempt: a } : { kind: 'unknown', reason: 'malformed_attempt' };
    }
    if (r.status === 409 && code === 'refund_authorization_invalid') return { kind: 'terminal', status: 'authorization_refused' };
    if (r.status === 409 && code === 'refund_authorization_expired') return { kind: 'terminal', status: 'authorization_expired' };
    if ((r.status === 409 || r.status === 422) && code && (PAYMENT_REFUSALS as readonly string[]).includes(code)) return { kind: 'refused', code: code as PaymentRefusal };
    if (r.status === 503 && code === 'refund_authorization_unresolved') return { kind: 'pending' };
    if (r.status === 409 && code === 'refund_attempt_conflict') return { kind: 'conflict' };
    return { kind: 'unknown', reason: code ?? `status_${r.status}` };
  }

  async capture(paymentId: string, factId: string): Promise<CaptureReadOutcome> {
    const r = await this.call('GET', `/payment/payments/${encodeURIComponent(paymentId)}/captures/${encodeURIComponent(factId)}`);
    if (r.status === 404) {
      const code = typeof r.body?.code === 'string' ? r.body.code : null;
      return { kind: 'not_found', reason: code === 'capture_not_found' ? 'capture_not_found' : code === 'not_found' ? 'collapsed' : 'unrecognized' };
    }
    const b = r.body;
    if (r.status !== 200 || !b) return { kind: 'unknown', reason: `status_${r.status}` };
    if (b.factId !== factId || b.paymentId !== paymentId || typeof b.amount !== 'number' || !Number.isSafeInteger(b.amount) || b.amount < 1
      || typeof b.currency !== 'string' || typeof b.paymentStatus !== 'string' || !CAPTURE_BASES.includes(b.basis as string)
      || typeof b.conflicted !== 'boolean' || !CAPTURE_REFUND.includes(b.refund as string) || typeof b.refundableOnItsOwn !== 'boolean') {
      return { kind: 'unknown', reason: 'malformed_capture' };
    }
    if (!consistentCaptureCount(b.attemptCaptures, b.basis as string)) return { kind: 'unknown', reason: 'inconsistent_capture_count' };
    if (!/^[A-Z]{3}$/.test(b.currency)) {
      const length = [...b.currency].length; // what a fact can hold (`0013`): characters, as PostgreSQL counts them
      return length >= 1 && length <= 16 ? { kind: 'ineligible_currency' } : { kind: 'unknown', reason: 'malformed_capture' };
    }
    return { kind: 'capture', capture: { factId, paymentId, amount: b.amount, currency: b.currency, paymentStatus: b.paymentStatus, basis: b.basis as CaptureBasis,
      conflicted: b.conflicted, refund: b.refund as PaymentCapture['refund'], refundableOnItsOwn: b.refundableOnItsOwn, attemptCaptures: b.attemptCaptures as number } };
  }

  async settlingCapture(paymentId: string): Promise<SettlingCaptureOutcome> {
    const r = await this.call('GET', `/payment/payments/${encodeURIComponent(paymentId)}/settling-capture`);
    const code = typeof r.body?.code === 'string' ? r.body.code : null;
    if (r.status === 404 && code === 'settling_capture_not_found') return { kind: 'none', reason: code };
    if (r.status === 409 && code === 'settling_capture_ambiguous') return { kind: 'ambiguous' };
    const b = r.body;
    if (r.status !== 200 || !b) return { kind: 'unknown', reason: code ?? `status_${r.status}` };
    if (b.paymentId !== paymentId || typeof b.factId !== 'string' || !UUID.test(b.factId) || typeof b.attemptId !== 'string' || !UUID.test(b.attemptId)
      || typeof b.amount !== 'number' || !Number.isSafeInteger(b.amount) || b.amount < 1 || typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency)
      || typeof b.conflicted !== 'boolean') {
      return { kind: 'unknown', reason: 'malformed_settling_capture' };
    }
    return { kind: 'capture', capture: { paymentId, attemptId: b.attemptId, factId: b.factId, amount: b.amount, currency: b.currency, conflicted: b.conflicted } };
  }

  async refunds(paymentId: string): Promise<PaymentRefunds | null> {
    const r = await this.call('GET', `/payment/payments/${encodeURIComponent(paymentId)}/refunds`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.attempts) || !Array.isArray(r.body.refusals)) {
      throw new Error(`payment-service GET refunds failed (status ${r.status})`);
    }
    const attempts = r.body.attempts.map(snapshot);
    if (attempts.some((a) => a === null)) throw new Error('payment-service GET refunds: malformed attempt');
    const refusals = (r.body.refusals as { refundAttemptId?: unknown; code?: unknown }[]).map((x) => {
      if (typeof x.refundAttemptId !== 'string' || !(PAYMENT_REFUSALS as readonly unknown[]).includes(x.code)) throw new Error('payment-service GET refunds: malformed refusal');
      return { refundAttemptId: x.refundAttemptId, code: x.code as PaymentRefusal };
    });
    // Core V2 S6c: the authorizations (absent from a Payment older than S6c: none)
    const raw = Array.isArray(r.body.authorizations) ? (r.body.authorizations as Record<string, unknown>[]) : [];
    const authorizations = raw.map((z) => {
      if (![z.refundAuthorizationId, z.refundAttemptId, z.refundCaseId].every((v) => typeof v === 'string' && UUID.test(v)) || typeof z.approvedAmount !== 'number'
        || typeof z.currency !== 'string' || (z.completedAt !== null && typeof z.completedAt !== 'string')) throw new Error('payment-service GET refunds: malformed authorization');
      // Core V2 S0-C14 item 6: each verified allocation is refund evidence; a malformed one proves nothing, so the whole answer is refused
      const rawAllocations = z.allocations === undefined ? [] : z.allocations;
      if (!Array.isArray(rawAllocations)) throw new Error('payment-service GET refunds: malformed allocations');
      const allocations = (rawAllocations as Record<string, unknown>[]).map((a) => {
        if (typeof a?.factId !== 'string' || !UUID.test(a.factId) || typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || typeof a.currency !== 'string') {
          throw new Error('payment-service GET refunds: malformed allocation');
        }
        return { factId: a.factId, amount: a.amount, currency: a.currency };
      });
      return { refundAuthorizationId: z.refundAuthorizationId as string, refundAttemptId: z.refundAttemptId as string, refundCaseId: z.refundCaseId as string,
        approvedAmount: z.approvedAmount, currency: z.currency, completedAt: (z.completedAt as string | null) ?? null, allocations };
    });
    // Core V2 S0-C14 item 6: the producer's unallocated refund facts; absent: null (proves nothing); malformed: the answer is refused
    let unallocatedFacts: UnallocatedRefundFact[] | null = null;
    if (r.body.unallocatedFacts !== undefined) {
      if (!Array.isArray(r.body.unallocatedFacts)) throw new Error('payment-service GET refunds: malformed unallocated facts');
      unallocatedFacts = (r.body.unallocatedFacts as Record<string, unknown>[]).map((f) => {
        if (typeof f?.factId !== 'string' || !UUID.test(f.factId) || (f.refundAttemptId !== null && (typeof f.refundAttemptId !== 'string' || !UUID.test(f.refundAttemptId)))
          || typeof f.amount !== 'number' || !Number.isSafeInteger(f.amount) || typeof f.currency !== 'string' || (f.state !== 'pending' && f.state !== 'blocked')) {
          throw new Error('payment-service GET refunds: malformed unallocated fact');
        }
        // Core V2 DO-73: Payment's block reason, kept only as a bounded code (anything else proves nothing and is dropped)
        const blockedReason = f.blockedReason === null ? null : typeof f.blockedReason === 'string' && /^[a-z][a-z_]{0,63}$/.test(f.blockedReason) ? f.blockedReason : undefined;
        return { factId: f.factId, refundAttemptId: f.refundAttemptId as string | null, amount: f.amount, currency: f.currency, state: f.state,
          ...(blockedReason !== undefined ? { blockedReason } : {}) };
      });
    }
    return { attempts: attempts as RefundAttemptSnapshot[], refusals, authorizations, unallocatedFacts, observationConflicts: parseObservationConflicts(r.body.observationConflicts),
      failedAttemptEvidence: parseFailedAttemptEvidence(r.body.failedAttemptEvidence) };
  }
}

/**
 * Core V2 DO-74: Payment's `observationConflicts`, parsed on its own. Absent: `null`. Anything malformed (a non-array, a non-UUID id, an empty or
 * duplicated id list, a count that is not the list's length) is `'malformed'` and never throws: a bad DO-74 field cannot turn the rest of PAY-08 (S0-C14's
 * evidence) into an unavailable answer.
 */
export function parseObservationConflicts(raw: unknown): ObservationConflict[] | 'malformed' | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return 'malformed';
  const out: ObservationConflict[] = [];
  const attempts = new Set<string>();
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object' || typeof e.refundAttemptId !== 'string' || !UUID.test(e.refundAttemptId) || attempts.has(e.refundAttemptId)) return 'malformed';
    if (!Array.isArray(e.conflictIds) || e.conflictIds.length < 1 || !e.conflictIds.every((x) => typeof x === 'string' && UUID.test(x))) return 'malformed';
    const ids = e.conflictIds as string[];
    if (new Set(ids).size !== ids.length || e.observations !== ids.length) return 'malformed';
    attempts.add(e.refundAttemptId);
    out.push({ refundAttemptId: e.refundAttemptId, conflictIds: ids, observations: ids.length });
  }
  return out;
}

/**
 * Core V2 R3: Payment's `failedAttemptEvidence`, parsed on its own. Absent: `null`. Anything malformed (a non-array, a non-UUID or repeated attempt, a state
 * outside the four) is `'malformed'` and never throws.
 */
export function parseFailedAttemptEvidence(raw: unknown): FailedAttemptEvidence[] | 'malformed' | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return 'malformed';
  const out: FailedAttemptEvidence[] = [];
  const seen = new Set<string>();
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object' || typeof e.refundAttemptId !== 'string' || !UUID.test(e.refundAttemptId) || seen.has(e.refundAttemptId)) return 'malformed';
    if (!(FAILED_ATTEMPT_EVIDENCE_STATES as readonly unknown[]).includes(e.state)) return 'malformed';
    seen.add(e.refundAttemptId);
    out.push({ refundAttemptId: e.refundAttemptId, state: e.state as FailedAttemptEvidenceState });
  }
  return out;
}
