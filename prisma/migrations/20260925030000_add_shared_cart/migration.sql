-- CreateTable
CREATE TABLE "SharedCart" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedCart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SharedCart_shop_locationGid_key" ON "SharedCart"("shop", "locationGid");
