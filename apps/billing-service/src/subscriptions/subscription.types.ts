import type { SubscriptionStatus } from '../domain/state-machines.js';

/** Shape of the `subscription` table as `pg` returns it. No money: what was charged lives in Invoice/InvoiceLine (section 40). */
export interface SubscriptionRow {
  id: string;
  organizationId: string;
  productId: string;
  priceId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  effectiveTerminationAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}
