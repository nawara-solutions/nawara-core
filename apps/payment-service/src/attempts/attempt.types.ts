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
  /** Core V2 S4a (P-6): its payment's mode, `false` (simulation only); NULL only on an attempt created before S4a. */
  liveMode: boolean | null;
}
