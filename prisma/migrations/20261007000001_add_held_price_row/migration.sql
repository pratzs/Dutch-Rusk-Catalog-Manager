-- CreateTable
CREATE TABLE "HeldPriceRow" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "priceListName" TEXT NOT NULL DEFAULT '',
    "variantGid" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "fixedAtHold" DOUBLE PRECISION NOT NULL,
    "lastCompareAt" DOUBLE PRECISION,
    "retailAtHold" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "compareAtCleared" BOOLEAN NOT NULL DEFAULT false,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeldPriceRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HeldPriceRow_priceListId_variantGid_key" ON "HeldPriceRow"("priceListId", "variantGid");

-- CreateIndex
CREATE INDEX "HeldPriceRow_shop_idx" ON "HeldPriceRow"("shop");
