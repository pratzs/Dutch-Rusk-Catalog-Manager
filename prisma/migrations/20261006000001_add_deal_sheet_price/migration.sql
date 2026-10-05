-- CreateTable
CREATE TABLE "DealSheetPrice" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'price',
    "month" TEXT NOT NULL,
    "dealPrice" DOUBLE PRECISION NOT NULL,
    "minQty" INTEGER,
    "baseKind" TEXT NOT NULL DEFAULT 'none',
    "basePct" DOUBLE PRECISION,
    "baseCustomPrice" DOUBLE PRECISION,
    "label" TEXT,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedAt" TIMESTAMP(3),
    "revertNote" TEXT,

    CONSTRAINT "DealSheetPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealSheetPrice_priceListId_variantGid_kind_key" ON "DealSheetPrice"("priceListId", "variantGid", "kind");

-- CreateIndex
CREATE INDEX "DealSheetPrice_shop_revertedAt_endsAt_idx" ON "DealSheetPrice"("shop", "revertedAt", "endsAt");

-- CreateIndex
CREATE INDEX "DealSheetPrice_variantGid_idx" ON "DealSheetPrice"("variantGid");
