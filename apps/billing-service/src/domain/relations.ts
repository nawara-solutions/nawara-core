import type { Caller } from './actors.js';

/**
 * A caller's relation to an invoice (SDD 19.3). Only two exist in v1, both derivable from the invoice itself:
 *  - `producer`: the caller is the service that created it;
 *  - `payer`: the payer is a `user` and is the caller.
 * Organization membership, seller staff and platform staff have NO relation (B-026, B-027, B-028), and neither does an Auth
 * administrator: Auth answers who someone is, never what they may do here.
 */
export type Relation = 'producer' | 'payer';

export function relationTo(invoice: { producer: string; payerType: string; payerId: string }, caller: Caller): Relation | null {
  if (caller.kind === 'service' && caller.service === invoice.producer) return 'producer';
  if (caller.kind === 'user' && invoice.payerType === 'user' && invoice.payerId === caller.userId) return 'payer';
  return null;
}

/**
 * A caller's relation to a product or price (SDD section 11: "reached by the producer that created it"). Only `producer`
 * exists: a product/price has no payer concept, and no membership-based relation (B-029, B-031: which services may act
 * for which sellers is not decided; this checks only "the same producer that created the row", never a seller scope).
 */
export function catalogRelationTo(row: { producer: string }, caller: Caller): 'producer' | null {
  return caller.kind === 'service' && caller.service === row.producer ? 'producer' : null;
}
