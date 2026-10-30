import { correlationHeaders } from '@nawara/service-kit';

export const PAYMENT_RECONCILIATION_CLIENT = Symbol('BILLING_PAYMENT_RECONCILIATION_CLIENT');

/** Core V2 S6h-B: the kinds of Payment's evidence Billing reconciles (PAY-12's producer read, `payment.reconciliation.read`). */
export const PAYMENT_ITEM_KINDS = ['late_success', 'over_return', 'refund_discrepancy', 'authorization_pending', 'chargeback', 'capture_refund_unavailable'] as const;
export type PaymentItemKind = (typeof PAYMENT_ITEM_KINDS)[number];

/** One item of Payment's evidence, as Payment states it (never derived): its id is the evidence's own identity. */
export interface PaymentItem {
  kind: PaymentItemKind;
  id: string;
  paymentId: string;
  factId: string | null;
  amount: number | null;
  currency: string | null;
  detail: Record<string, unknown>;
  at: string | null;
}

export interface PaymentReconciliationClient {
  /** One page of Billing's own payments' evidence of one kind (keyset by id). Throws when Payment cannot answer: nothing is inferred. */
  items(kind: PaymentItemKind, after: string | undefined, limit: number): Promise<PaymentItem[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function item(kind: PaymentItemKind, v: unknown): PaymentItem | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.paymentId !== 'string' || !UUID.test(r.paymentId)) return null;
  const amount = r.amount === null || r.amount === undefined ? null : r.amount;
  if (amount !== null && (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1)) return null;
  const currency = typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? r.currency : null;
  if ((amount === null) !== (currency === null)) return null;
  const factId = typeof r.factId === 'string' && UUID.test(r.factId) ? r.factId : null;
  const detail = r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {};
  return { kind, id: r.id, paymentId: r.paymentId, factId, amount, currency, detail, at: typeof r.at === 'string' ? r.at : null };
}

/** Billing's OWN service token only (ADR-0033). An unanswerable or malformed page throws: Billing never reads a gap as "no evidence". */
export class HttpPaymentReconciliationClient implements PaymentReconciliationClient {
  constructor(private readonly opts: { baseUrl: string; serviceToken: string; timeoutMs: number }) {}

  async items(kind: PaymentItemKind, after: string | undefined, limit: number): Promise<PaymentItem[]> {
    const qs = new URLSearchParams({ kind, limit: String(limit), ...(after ? { after } : {}) });
    const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/payment/reconciliation/items?${qs.toString()}`, {
      headers: { authorization: `Bearer ${this.opts.serviceToken}`, ...correlationHeaders() },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (res.status !== 200) throw new Error(`payment reconciliation read failed (status ${res.status})`);
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) throw new Error('payment reconciliation read: malformed answer');
    const items = body.items.map((v) => item(kind, v));
    if (items.some((i) => i === null)) throw new Error('payment reconciliation read: malformed item');
    return items as PaymentItem[];
  }
}
