-- CreateTable
CREATE TABLE "OidcRefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "b2bUserId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OidcRefreshToken_tokenHash_key" ON "OidcRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OidcRefreshToken_b2bUserId_idx" ON "OidcRefreshToken"("b2bUserId");

-- CreateIndex
CREATE INDEX "OidcRefreshToken_expiresAt_idx" ON "OidcRefreshToken"("expiresAt");
