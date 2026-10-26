import type { PaymentStatus } from './payment-state-machine.js';

/** Shape of the `payment` table row (SDD section 4.1). Column names match the database exactly. */
export interface PaymentRow {
  id: string;
  producer: string;
  paymentRequestId: string;
  sourceType: string;
  sourceId: string;
  payerType: string;
  payerId: string;
  sellerType: string;
  sellerId: string;
  organizationId: string | null;
  amount: string; // bigint arrives from `pg` as a string
  currency: string;
  description: string | null;
  reference: string | null;
  expiresAt: Date | null;
  status: PaymentStatus;
  statusReason: string | null;
  settledMethod: 'gateway' | 'cash' | null;
  succeededAttemptId: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  /** Core V2 S4a (P-1): the producer's immutable settlement purpose; NULL only on a payment created before S4a (never backfilled). */
  purpose: PaymentPurpose | null;
  /** Core V2 S4a (P-3): the beneficiary of a direct purchase (the payer) or an assisted settlement; NULL otherwise. */
  beneficiaryUserId: string | null;
  /** Core V2 S4a (P-6): `false` on every new payment (simulation only); NULL only before S4a. Server-derived, never a request value. */
  liveMode: boolean | null;
  /** Core V2 S4c (F-1): why the payment started closing (`cancel` | `expiry`) and the database time it did; NULL if it never closed that way. */
  closingReason: 'cancel' | 'expiry' | null;
  closingSince: Date | null;
}

/** ADR-0044 B2 purposes (Core V2 S4a, P-1): the database admits all five (DB-15); the API accepts {@link ACCEPTED_PURPOSES} (P-5). */
export const PAYMENT_PURPOSES = ['organization_subscription', 'direct_purchase', 'assisted_settlement', 'recovery_settlement', 'non_entitlement'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];
/** P-5: the Organization-payer purposes stay closed at the API until their own stages (S4e, S5, S6) authorize those workflows. */
export const ACCEPTED_PURPOSES = ['organization_subscription', 'direct_purchase', 'non_entitlement'] as const satisfies readonly PaymentPurpose[];

/**
 * Core V2 S4a (P-6, FC-10): Core V2 is certified on simulation only and no live provider exists or is authorized, so every new payment
 * and attempt is non-live. A later real-provider stage replaces this under its own authorization (and widens the database CHECK).
 */
export const CORE_V2_LIVE_MODE = false;
