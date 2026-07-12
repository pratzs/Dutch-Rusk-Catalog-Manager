-- CreateTable
CREATE TABLE "B2BAccessEmailLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "companyContactId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2BAccessEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "B2BAccessEmailLog_companyContactId_key" ON "B2BAccessEmailLog"("companyContactId");

-- CreateIndex
CREATE INDEX "B2BAccessEmailLog_shop_idx" ON "B2BAccessEmailLog"("shop");
