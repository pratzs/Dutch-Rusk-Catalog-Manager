-- CreateTable
CREATE TABLE "SalesRep" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "repCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesRep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesRep_shop_idx" ON "SalesRep"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SalesRep_shop_repCode_key" ON "SalesRep"("shop", "repCode");
