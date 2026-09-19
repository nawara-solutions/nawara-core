-- Stage 3 addition: the producer isolation the SDD already documents for the catalog (section 11, "Isolation: reached by
-- the producer that created it") but Stage 2's migration did not add a column for, because no HTTP endpoint existed yet to
-- need it. Mirrors invoice.producer exactly (sections 6, 19.3): the authenticated service-token caller that created the
-- product, asserted by the guard, NEVER by the client. A price has no producer column of its own: a price is reached only
-- through its product (the same producer that created the product controls its prices; who may act for which SELLER is
-- still B-029/B-031 and is not decided here).
--
-- The table has been empty in every environment until now (Stage 2 built no write endpoint), so this is a plain additive
-- column, not a backfill.

ALTER TABLE product ADD COLUMN producer text NOT NULL;
ALTER TABLE product ADD CONSTRAINT product_producer_shape CHECK (producer ~ '^[a-z][a-z0-9-]{1,62}$');
CREATE INDEX product_producer_idx ON product (producer);

-- product_10_immutable already refuses a change to any column not on its allow-list ('status', 'revision', 'updatedAt'),
-- so `producer` is immutable by default (BI-07 pattern): nothing further to add.
