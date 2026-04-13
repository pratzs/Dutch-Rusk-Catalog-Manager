-- CreateTable
CREATE TABLE "LocationCatalogMap" (
    "id" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationCatalogMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LocationCatalogMap_locationGid_key" ON "LocationCatalogMap"("locationGid");
