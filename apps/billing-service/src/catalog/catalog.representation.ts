import { fromDbAmount, toJsonAmount } from '../domain/money.js';
import type { PriceRow, ProductRow } from './catalog.types.js';

/** The API representation of a product (SDD section 11). `producer` is an internal isolation detail, never exposed (as invoice's representation, section 9, also omits `producer`). */
export interface ProductRepresentation {
  id: string;
  seller: { type: string; id: string };
  code: string;
  name: string;
  description: string | null;
  entitlementKind: string;
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export function representProduct(row: ProductRow): ProductRepresentation {
  return {
    id: row.id,
    seller: { type: row.sellerType, id: row.sellerId },
    code: row.code,
    name: row.name,
    description: row.description,
    entitlementKind: row.entitlementKind,
    status: row.status,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The API representation of a price (SDD section 12). */
export interface PriceRepresentation {
  id: string;
  productId: string;
  clientReference: string;
  currency: string;
  unitAmount: number;
  interval: string;
  intervalUnit: string | null;
  intervalCount: number | null;
  pricingModel: string;
  effectiveFrom: string;
  retiredAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export function representPrice(row: PriceRow): PriceRepresentation {
  return {
    id: row.id,
    productId: row.productId,
    clientReference: row.clientReference,
    currency: row.currency,
    unitAmount: toJsonAmount(fromDbAmount(row.unitAmount)),
    interval: row.interval,
    intervalUnit: row.intervalUnit,
    intervalCount: row.intervalCount,
    pricingModel: row.pricingModel,
    effectiveFrom: row.effectiveFrom.toISOString(),
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
