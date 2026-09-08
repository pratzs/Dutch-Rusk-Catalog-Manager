-- Full set of price lists each company location can be priced from.
-- Additive and defaulted, so existing rows stay valid and the catalog-rules
-- endpoint keeps working while the next price sync backfills real values.
ALTER TABLE "LocationCatalogMap" ADD COLUMN "priceListIds" TEXT NOT NULL DEFAULT '[]';
