import { correlationHeaders } from '@nawara/service-kit';

/** DI tokens of the fraud holds' two outbound boundaries (Core V2 S6e-H). */
export const FRAUD_HOLD_RECEIPTS = Symbol('BILLING_FRAUD_HOLD_RECEIPTS');
export const FRAUD_EVIDENCE_FILES = Symbol('BILLING_FRAUD_EVIDENCE_FILES');

/** A Billing-consumed receipt binding, exactly as Auth issued it (AUTH-01; S6e-H prerequisite #393; S6f prerequisite #396). */
export type FraudHoldBinding =
  | { operation: 'fraud_hold_place'; audience: 'billing-service'; companyId: string; holdId: string; beneficiaryUserId: string; productId: string; reason: string }
  | { operation: 'fraud_hold_release'; audience: 'billing-service'; companyId: string; holdId: string; beneficiaryUserId: string; productId: string }
  // Core V2 S6f (R6F-5 Path B; Auth #396): an Owner's record that one recovery surplus was repaid outside Core
  | { operation: 'recovery_surplus_external'; audience: 'billing-service'; companyId: string; surplusId: string; organizationId: string; amount: number; currency: string };

export interface ReceiptConsumption { receiptId: string; approvedByUserId: string }

/**
 * What Auth's answer PROVES (the S6b rule): a consumption, or a definitive refusal (`receipt_invalid`, `receipt_binding_invalid`,
 * `receipt_expired`). Anything else (`authority_revoked`, `consume_ref_conflict`, unavailable, a timeout, an unexpected answer) proves
 * nothing: the operation is not performed, and the same request may be repeated.
 */
export type ConsumeOutcome = { kind: 'consumed'; consumption: ReceiptConsumption } | { kind: 'refused'; code: string } | { kind: 'unresolved'; reason: string };

export interface FraudHoldReceipts {
  consume(input: { secret: string; binding: FraudHoldBinding; consumeRef: string }): Promise<ConsumeOutcome>;
  /** AUTH-03: the consumption under this reference for this binding, or null (which proves nothing). Throws when Auth cannot answer. */
  lookup(input: { binding: FraudHoldBinding; consumeRef: string }): Promise<ReceiptConsumption | null>;
}

/** File's answer about one `fraud_evidence` grant to Billing (FIL-02, S6e-H prerequisite #394). */
export interface GrantedFraudEvidence { grantId: string; fileId: string; purpose: string; caseRef: string; companyId: string | null; subjectUserId: string | null }

export interface FraudEvidenceFiles {
  /** null: File's one 404 (not a usable grant to Billing for that file); throws when File cannot answer. */
  granted(grantId: string, fileId: string, deadline: AbortSignal): Promise<GrantedFraudEvidence | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function call(url: string, token: string, timeoutMs: number, body?: unknown): Promise<{ status: number; body: Record<string, any> | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', ...correlationHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 0, body: null };
  }
  try {
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } catch {
    return { status: res.status, body: null };
  }
}

/** Billing's own service token to Auth's receipt routes (AUTH-02, AUTH-03); the secret only in the body, never logged. */
export class HttpFraudHoldReceipts implements FraudHoldReceipts {
  constructor(private readonly opts: { baseUrl: string; serviceToken: string; timeoutMs: number }) {}

  private consumption(b: Record<string, any> | null, consumeRef: string, binding: FraudHoldBinding): ReceiptConsumption | null {
    if (!b || typeof b.receiptId !== 'string' || !UUID.test(b.receiptId) || b.consumeRef !== consumeRef || b.companyId !== binding.companyId
      || typeof b.approvedBy?.userId !== 'string' || !UUID.test(b.approvedBy.userId)) return null;
    return { receiptId: b.receiptId, approvedByUserId: b.approvedBy.userId.toLowerCase() };
  }

  async consume(input: { secret: string; binding: FraudHoldBinding; consumeRef: string }): Promise<ConsumeOutcome> {
    const r = await call(`${this.opts.baseUrl.replace(/\/+$/, '')}/auth/service/authorization-receipts/consume`, this.opts.serviceToken, this.opts.timeoutMs, input);
    if (r.status === 200) {
      const c = this.consumption(r.body, input.consumeRef, input.binding);
      return c ? { kind: 'consumed', consumption: c } : { kind: 'unresolved', reason: 'malformed_consumption' };
    }
    const code = typeof r.body?.code === 'string' ? r.body.code : null;
    if (code && ['receipt_invalid', 'receipt_binding_invalid', 'receipt_expired'].includes(code) && (r.status === 409 || r.status === 400)) return { kind: 'refused', code };
    return { kind: 'unresolved', reason: code ?? `status_${r.status}` };
  }

  async lookup(input: { binding: FraudHoldBinding; consumeRef: string }): Promise<ReceiptConsumption | null> {
    const r = await call(`${this.opts.baseUrl.replace(/\/+$/, '')}/auth/service/authorization-receipts/consumptions/lookup`, this.opts.serviceToken, this.opts.timeoutMs, input);
    if (r.status === 404) return null;
    const c = r.status === 200 ? this.consumption(r.body, input.consumeRef, input.binding) : null;
    if (!c) throw new Error(`auth lookup failed (status ${r.status})`);
    return c;
  }
}

/** Billing's own service token to File's granted metadata read (`read_granted`, purpose `fraud_evidence`). */
export class HttpFraudEvidenceFiles implements FraudEvidenceFiles {
  constructor(private readonly opts: { baseUrl: string; serviceToken: string; timeoutMs: number }) {}

  async granted(grantId: string, fileId: string): Promise<GrantedFraudEvidence | null> {
    const r = await call(`${this.opts.baseUrl.replace(/\/+$/, '')}/file/evidence-grants/${encodeURIComponent(grantId)}/files/${encodeURIComponent(fileId)}`,
      this.opts.serviceToken, this.opts.timeoutMs);
    if (r.status === 404) return null;
    const g = r.body?.grant;
    if (r.status !== 200 || typeof r.body?.id !== 'string' || !g || typeof g.id !== 'string' || typeof g.purpose !== 'string' || typeof g.caseRef !== 'string') {
      throw new Error(`file-service granted read failed (status ${r.status})`);
    }
    const low = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);
    return { grantId: g.id.toLowerCase(), fileId: r.body.id.toLowerCase(), purpose: g.purpose, caseRef: g.caseRef.toLowerCase(), companyId: low(g.companyId), subjectUserId: low(g.subjectUserId) };
  }
}

/** Where fraud holds are not configured: nothing can be verified, so nothing is placed or released (503). */
export class FraudHoldsNotConfigured implements FraudHoldReceipts, FraudEvidenceFiles {
  async consume(): Promise<ConsumeOutcome> {
    throw new Error('fraud holds are not configured');
  }
  async lookup(): Promise<ReceiptConsumption | null> {
    throw new Error('fraud holds are not configured');
  }
  async granted(): Promise<GrantedFraudEvidence | null> {
    throw new Error('fraud holds are not configured');
  }
}
