/** Shapes of the catalog tables as `pg` returns them: `unitAmount` arrives as a decimal STRING (`fromDbAmount` converts it). */
export interface ProductRow {
  id: string;
  producer: string;
  sellerType: string;
  sellerId: string;
  code: string;
  name: string;
  description: string | null;
  entitlementKind: string;
  status: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceRow {
  id: string;
  productId: string;
  clientReference: string;
  currency: string;
  unitAmount: string;
  interval: string;
  intervalUnit: string | null;
  intervalCount: number | null;
  pricingModel: string;
  effectiveFrom: Date;
  retiredAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A price joined with its product's producer, for the relation check (SDD 11: a price is reached only through its product). */
export interface PriceWithProducer extends PriceRow {
  producer: string;
}
