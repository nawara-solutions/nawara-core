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
}
