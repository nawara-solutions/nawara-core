import type { AttemptStatus } from './attempt-state-machine.js';

/** Shape of the `payment_attempt` table row (SDD section 4.2). Column names match the database exactly. */
export interface AttemptRow {
  id: string;
  paymentId: string;
  attemptNumber: number;
  provider: string;
  merchantReference: string;
  providerTransactionId: string | null;
  status: AttemptStatus;
  failureCode: string | null;
  failureClass: 'retryable' | 'terminal' | 'ambiguous' | null;
  failureInferred: boolean;
  providerData: unknown;
  initiatedAt: Date;
  submittedAt: Date | null;
  completedAt: Date | null;
}
