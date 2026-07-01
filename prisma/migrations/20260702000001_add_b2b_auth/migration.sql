-- CreateTable
CREATE TABLE "B2BUser" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "email" TEXT NOT NULL,
    "customerGid" TEXT NOT NULL,
    "companyContactGid" TEXT NOT NULL,
    "companyGid" TEXT NOT NULL,
    "companyLocationGid" TEXT NOT NULL,
    "storeDisplayName" TEXT NOT NULL,
    "catalogGroup" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "lastLoginAt" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "B2BUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B2BPasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'reset',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2BPasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B2BLoginAudit" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT,
    "result" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2BLoginAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcSigningKey" (
    "id" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'RS256',
    "publicJwk" JSONB NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "activeForSigning" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "OidcSigningKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcAuthCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "b2bUserId" TEXT NOT NULL,
    "customerGid" TEXT NOT NULL,
    "companyLocationGid" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "nonce" TEXT,
    "scope" TEXT NOT NULL,
    "codeChallenge" TEXT,
    "codeChallengeMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "OidcAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B2BOtpCode" (
    "id" TEXT NOT NULL,
    "b2bUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2BOtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "B2BUser_shop_username_key" ON "B2BUser"("shop", "username");

-- CreateIndex
CREATE INDEX "B2BUser_shop_email_idx" ON "B2BUser"("shop", "email");

-- CreateIndex
CREATE INDEX "B2BUser_shop_catalogGroup_idx" ON "B2BUser"("shop", "catalogGroup");

-- CreateIndex
CREATE INDEX "B2BUser_customerGid_idx" ON "B2BUser"("customerGid");

-- CreateIndex
CREATE UNIQUE INDEX "B2BPasswordResetToken_tokenHash_key" ON "B2BPasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "B2BPasswordResetToken_userId_idx" ON "B2BPasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "B2BLoginAudit_shop_createdAt_idx" ON "B2BLoginAudit"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "B2BLoginAudit_username_idx" ON "B2BLoginAudit"("username");

-- CreateIndex
CREATE UNIQUE INDEX "OidcSigningKey_kid_key" ON "OidcSigningKey"("kid");

-- CreateIndex
CREATE UNIQUE INDEX "OidcAuthCode_code_key" ON "OidcAuthCode"("code");

-- CreateIndex
CREATE INDEX "OidcAuthCode_expiresAt_idx" ON "OidcAuthCode"("expiresAt");

-- CreateIndex
CREATE INDEX "B2BOtpCode_b2bUserId_idx" ON "B2BOtpCode"("b2bUserId");

-- CreateIndex
CREATE INDEX "B2BOtpCode_expiresAt_idx" ON "B2BOtpCode"("expiresAt");
