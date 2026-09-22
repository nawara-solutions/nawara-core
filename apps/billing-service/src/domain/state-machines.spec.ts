import { describe, expect, it } from 'vitest';
import {
  ACTIVE_PAYMENT_REQUEST_STATUSES, INVOICE_STATUSES, PAYMENT_REQUEST_STATUSES, SUBSCRIPTION_STATUSES, canTransitionInvoice, canTransitionPaymentRequest, canTransitionSubscription,
  isOverdue, isTerminalInvoiceStatus, isTerminalPaymentRequestStatus,
} from './state-machines.js';

describe('invoice state machine (SDD 17.1, BI-16)', () => {
  it('has exactly draft, open, paid, void; overdue is derived and not a state', () => {
    expect([...INVOICE_STATUSES]).toEqual(['draft', 'open', 'paid', 'void']);
    expect(INVOICE_STATUSES as readonly string[]).not.toContain('overdue');
  });

  it('allows exactly draft->open, draft->void, open->paid', () => {
    const allowed = INVOICE_STATUSES.flatMap((f) => INVOICE_STATUSES.filter((t) => canTransitionInvoice(f, t)).map((t) => `${f}>${t}`));
    expect(allowed.sort()).toEqual(['draft>open', 'draft>void', 'open>paid']);
  });

  it('open->void is NOT allowed until B-015 is decided; paid and void are terminal', () => {
    expect(canTransitionInvoice('open', 'void')).toBe(false);
    expect(isTerminalInvoiceStatus('paid') && isTerminalInvoiceStatus('void')).toBe(true);
    expect(isTerminalInvoiceStatus('open')).toBe(false);
  });

  it('overdue is open AND past due by the supplied (database) clock; never a draft, paid, void or an invoice with no due date', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const past = new Date('2026-05-01T00:00:00Z');
    expect(isOverdue({ status: 'open', dueAt: past }, now)).toBe(true);
    expect(isOverdue({ status: 'open', dueAt: now }, now)).toBe(true);
    expect(isOverdue({ status: 'open', dueAt: new Date('2026-07-01T00:00:00Z') }, now)).toBe(false);
    expect(isOverdue({ status: 'open', dueAt: null }, now)).toBe(false);
    for (const status of ['draft', 'paid', 'void'] as const) expect(isOverdue({ status, dueAt: past }, now)).toBe(false);
  });
});

describe('payment request state machine (SDD 17.3)', () => {
  it('allows exactly the SDD transitions', () => {
    const allowed = PAYMENT_REQUEST_STATUSES.flatMap((f) => PAYMENT_REQUEST_STATUSES.filter((t) => canTransitionPaymentRequest(f, t)).map((t) => `${f}>${t}`));
    expect(allowed.sort()).toEqual([
      'created>cancelled', 'created>sending', 'requested>cancelled', 'requested>expired', 'requested>failed', 'requested>paid', 'sending>rejected', 'sending>requested',
    ]);
  });

  it('every closed state is terminal and the active states are exactly created, sending, requested (BI-13)', () => {
    for (const s of ['paid', 'failed', 'cancelled', 'expired', 'rejected'] as const) expect(isTerminalPaymentRequestStatus(s)).toBe(true);
    expect([...ACTIVE_PAYMENT_REQUEST_STATUSES]).toEqual(['created', 'sending', 'requested']);
    for (const s of ACTIVE_PAYMENT_REQUEST_STATUSES) expect(isTerminalPaymentRequestStatus(s)).toBe(false);
  });
});

describe('subscription state machine (Stage 12.2)', () => {
  it('has exactly pending, active, grace, expired; no cancel_scheduled, terminated, past_due or similar', () => {
    expect([...SUBSCRIPTION_STATUSES]).toEqual(['pending', 'active', 'grace', 'expired']);
    for (const forbidden of ['cancel_scheduled', 'terminated', 'renewing', 'payment_failed', 'past_due', 'unpaid', 'paused']) {
      expect(SUBSCRIPTION_STATUSES as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it('allows exactly pending->active, active->active|grace|expired, grace->active|expired, expired->active', () => {
    const allowed = SUBSCRIPTION_STATUSES.flatMap((f) => SUBSCRIPTION_STATUSES.filter((t) => canTransitionSubscription(f, t)).map((t) => `${f}>${t}`));
    expect(allowed.sort()).toEqual([
      'active>active', 'active>expired', 'active>grace', 'expired>active', 'grace>active', 'grace>expired', 'pending>active',
    ]);
  });

  it('active is the ONLY self-loop (renewal / cancellation toggle): grace and expired never repeat themselves', () => {
    expect(canTransitionSubscription('active', 'active')).toBe(true);
    expect(canTransitionSubscription('grace', 'grace')).toBe(false);
    expect(canTransitionSubscription('expired', 'expired')).toBe(false);
    expect(canTransitionSubscription('pending', 'pending')).toBe(false);
  });

  it('a lapsed subscription can always be reactivated by a late renewal; a pending one is never reachable from anywhere but itself', () => {
    expect(canTransitionSubscription('expired', 'active')).toBe(true);
    for (const from of SUBSCRIPTION_STATUSES) if (from !== 'pending') expect(canTransitionSubscription(from, 'pending')).toBe(false);
  });
});
