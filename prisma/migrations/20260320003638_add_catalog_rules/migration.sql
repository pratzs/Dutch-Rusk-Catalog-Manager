-- CreateTable
CREATE TABLE "CatalogRule" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "catalogName" TEXT NOT NULL,
    "hiddenVariantTypes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOverride" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "hiddenVariantIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogRule_catalogId_key" ON "CatalogRule"("catalogId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOverride_catalogId_productId_key" ON "ProductOverride"("catalogId", "productId");
