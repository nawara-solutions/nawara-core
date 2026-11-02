import type { VerifiedOwner } from '../disputes/owner-company.authority.js';

/** What a decision may read of an unmatched fact: its identity and its money, never anything the provider asserted about who it belongs to. */
export interface UnmatchedFact {
  id: string;
  kind: 'capture' | 'refund' | 'chargeback';
  amount: string;
  currency: string;
}

/**
 * Finding F-29 (register PAY-12 G, PAY-13 H; Accepted ADR-0050: an Owner's authority is bounded by its own Company). An unmatched provider fact
 * has no payment, so nothing in Payment establishes which Company it belongs to: not the provider's metadata or reference, not the destination
 * an Owner names, not an Auth receipt (which proves who approved, never whose money it is), and not the existence of a single Company.
 * Until an approved authority and scope basis exists, the answer is always no.
 */
export interface UnmatchedFactAuthority {
  authorizes(owner: VerifiedOwner, fact: UnmatchedFact): boolean;
}

export const UNMATCHED_FACT_AUTHORITY = Symbol('UNMATCHED_FACT_AUTHORITY');

/** The only production implementation: fail closed. */
export const NO_UNMATCHED_FACT_AUTHORITY: UnmatchedFactAuthority = { authorizes: () => false };
