-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLAYER', 'ADMIN');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('USER', 'CITY', 'COMPANY', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PLAYER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mutedUntil" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "World" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "seed" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "tick" INTEGER NOT NULL DEFAULT 0,
    "tickIntervalMs" INTEGER NOT NULL,
    "lastTickAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "baseRate" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "priceIndex" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "priceIndexYearAgo" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "creditOutstanding" BIGINT NOT NULL DEFAULT 0,
    "creditPrev" BIGINT NOT NULL DEFAULT 0,
    "avgAttractiveness" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "World_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TickRun" (
    "tick" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "phases" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "TickRun_pkey" PRIMARY KEY ("tick")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" BIGSERIAL NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "memo" TEXT,
    "tick" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "originX" INTEGER NOT NULL,
    "originY" INTEGER NOT NULL,
    "tiles" JSONB NOT NULL DEFAULT '{}',
    "pop" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "derived" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastTick" INTEGER NOT NULL DEFAULT 0,
    "foundedTick" INTEGER NOT NULL DEFAULT 0,
    "deficitDays" INTEGER NOT NULL DEFAULT 0,
    "receivership" BOOLEAN NOT NULL DEFAULT false,
    "retailSatisfaction" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Parcel" (
    "px" INTEGER NOT NULL,
    "py" INTEGER NOT NULL,
    "cityId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Parcel_pkey" PRIMARY KEY ("px","py")
);

-- CreateTable
CREATE TABLE "CityStat" (
    "cityId" TEXT NOT NULL,
    "tick" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "CityStat_pkey" PRIMARY KEY ("cityId","tick")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "founderId" TEXT NOT NULL,
    "hqCityId" TEXT NOT NULL,
    "totalShares" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "parentCompanyId" TEXT,
    "creditScore" INTEGER NOT NULL DEFAULT 70,
    "rating" TEXT NOT NULL DEFAULT 'A',
    "missedPayments" INTEGER NOT NULL DEFAULT 0,
    "createdTick" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shareholding" (
    "companyId" TEXT NOT NULL,
    "holderType" "OwnerType" NOT NULL,
    "holderId" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Shareholding_pkey" PRIMARY KEY ("companyId","holderType","holderId")
);

-- CreateTable
CREATE TABLE "CompanyRole" (
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyRole_pkey" PRIMARY KEY ("companyId","userId","role")
);

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "condition" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "upgrades" INTEGER NOT NULL DEFAULT 0,
    "carry" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "staffing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "power" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "water" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "utilityCharge" INTEGER NOT NULL DEFAULT 0,
    "lastEnergy" INTEGER NOT NULL DEFAULT 0,
    "lastRuns" INTEGER NOT NULL DEFAULT 0,
    "limitedBy" TEXT NOT NULL DEFAULT 'idle',
    "builtTick" INTEGER NOT NULL DEFAULT 0,
    "cost" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "companyId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "good" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "avgCost" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("companyId","cityId","good")
);

-- CreateTable
CREATE TABLE "MarketState" (
    "instrument" TEXT NOT NULL,
    "refPrice" BIGINT NOT NULL,
    "lastPrice" BIGINT,
    "dayVolume" INTEGER NOT NULL DEFAULT 0,
    "unmetDemand" INTEGER NOT NULL DEFAULT 0,
    "dayImports" INTEGER NOT NULL DEFAULT 0,
    "dayExports" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MarketState_pkey" PRIMARY KEY ("instrument")
);

-- CreateTable
CREATE TABLE "MarketOrder" (
    "id" BIGSERIAL NOT NULL,
    "instrument" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "traderType" "OwnerType" NOT NULL,
    "traderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cityId" TEXT,
    "escrow" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" BIGSERIAL NOT NULL,
    "instrument" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "buyOrderId" BIGINT,
    "sellOrderId" BIGINT,
    "buyerType" "OwnerType" NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerType" "OwnerType" NOT NULL,
    "sellerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BOOK',
    "tick" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "instrument" TEXT NOT NULL,
    "tick" INTEGER NOT NULL,
    "ref" BIGINT NOT NULL,
    "last" BIGINT,
    "volume" INTEGER NOT NULL,
    "unmet" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("instrument","tick")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "good" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fromCityId" TEXT NOT NULL,
    "toCityId" TEXT NOT NULL,
    "departTick" INTEGER NOT NULL,
    "arriveTick" INTEGER NOT NULL,
    "cost" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'IN_TRANSIT',
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "sellerCompanyId" TEXT NOT NULL,
    "buyerCompanyId" TEXT NOT NULL,
    "good" TEXT NOT NULL,
    "quantityPerDelivery" INTEGER NOT NULL,
    "pricePerUnit" BIGINT NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "deliveriesTotal" INTEGER NOT NULL,
    "deliveriesDone" INTEGER NOT NULL DEFAULT 0,
    "misses" INTEGER NOT NULL DEFAULT 0,
    "penaltyPerMiss" BIGINT NOT NULL,
    "fromCityId" TEXT NOT NULL,
    "toCityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "proposedById" TEXT NOT NULL,
    "proposedBySide" TEXT NOT NULL,
    "nextDueTick" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "lenderAccountId" TEXT NOT NULL,
    "borrowerType" "OwnerType" NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "principal" BIGINT NOT NULL,
    "outstanding" BIGINT NOT NULL,
    "annualRate" DOUBLE PRECISION NOT NULL,
    "termDays" INTEGER NOT NULL,
    "payment" BIGINT NOT NULL,
    "nextDueTick" INTEGER NOT NULL,
    "missed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "restructured" BOOLEAN NOT NULL DEFAULT false,
    "createdTick" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "proposerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "result" TEXT,
    "expiresTick" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vote" (
    "proposalId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "approve" BOOLEAN NOT NULL,
    "weight" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("proposalId","voterId")
);

-- CreateTable
CREATE TABLE "ResearchProject" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "cityId" TEXT,
    "techId" TEXT NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "requiredDays" INTEGER NOT NULL,
    "dailyCost" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedTick" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patent" (
    "id" TEXT NOT NULL,
    "techId" TEXT NOT NULL,
    "ownerCompanyId" TEXT,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "licenseFee" BIGINT NOT NULL DEFAULT 0,
    "grantedTick" INTEGER NOT NULL,
    "expiresTick" INTEGER NOT NULL,

    CONSTRAINT "Patent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "License" (
    "patentId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "startedTick" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "License_pkey" PRIMARY KEY ("patentId","companyId")
);

-- CreateTable
CREATE TABLE "Alliance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "leaderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alliance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllianceMember" (
    "allianceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllianceMember_pkey" PRIMARY KEY ("allianceId","userId")
);

-- CreateTable
CREATE TABLE "AllianceInvite" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllianceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllianceSanction" (
    "allianceId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllianceSanction_pkey" PRIMARY KEY ("allianceId","targetUserId")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" BIGSERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friendship" (
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("requesterId","addresseeId")
);

-- CreateTable
CREATE TABLE "Block" (
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "messageId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorldEvent" (
    "id" BIGSERIAL NOT NULL,
    "tick" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "cityId" TEXT,
    "userId" TEXT,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorldEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyStat" (
    "companyId" TEXT NOT NULL,
    "tick" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "CompanyStat_pkey" PRIMARY KEY ("companyId","tick")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("userId","key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Account_ownerType_ownerId_key" ON "Account"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_fromAccountId_id_idx" ON "LedgerEntry"("fromAccountId", "id");

-- CreateIndex
CREATE INDEX "LedgerEntry_toAccountId_id_idx" ON "LedgerEntry"("toAccountId", "id");

-- CreateIndex
CREATE INDEX "LedgerEntry_kind_tick_idx" ON "LedgerEntry"("kind", "tick");

-- CreateIndex
CREATE INDEX "City_ownerId_idx" ON "City"("ownerId");

-- CreateIndex
CREATE INDEX "City_originX_originY_idx" ON "City"("originX", "originY");

-- CreateIndex
CREATE INDEX "Parcel_cityId_idx" ON "Parcel"("cityId");

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");

-- CreateIndex
CREATE INDEX "Company_founderId_idx" ON "Company"("founderId");

-- CreateIndex
CREATE INDEX "Shareholding_holderType_holderId_idx" ON "Shareholding"("holderType", "holderId");

-- CreateIndex
CREATE INDEX "CompanyRole_userId_idx" ON "CompanyRole"("userId");

-- CreateIndex
CREATE INDEX "Facility_companyId_idx" ON "Facility"("companyId");

-- CreateIndex
CREATE INDEX "Facility_cityId_idx" ON "Facility"("cityId");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_x_y_key" ON "Facility"("x", "y");

-- CreateIndex
CREATE INDEX "Inventory_cityId_idx" ON "Inventory"("cityId");

-- CreateIndex
CREATE INDEX "MarketOrder_instrument_side_status_price_idx" ON "MarketOrder"("instrument", "side", "status", "price");

-- CreateIndex
CREATE INDEX "MarketOrder_traderType_traderId_status_idx" ON "MarketOrder"("traderType", "traderId", "status");

-- CreateIndex
CREATE INDEX "Trade_instrument_id_idx" ON "Trade"("instrument", "id");

-- CreateIndex
CREATE INDEX "Trade_buyerId_idx" ON "Trade"("buyerId");

-- CreateIndex
CREATE INDEX "Trade_sellerId_idx" ON "Trade"("sellerId");

-- CreateIndex
CREATE INDEX "Shipment_status_arriveTick_idx" ON "Shipment"("status", "arriveTick");

-- CreateIndex
CREATE INDEX "Shipment_companyId_idx" ON "Shipment"("companyId");

-- CreateIndex
CREATE INDEX "Contract_sellerCompanyId_idx" ON "Contract"("sellerCompanyId");

-- CreateIndex
CREATE INDEX "Contract_buyerCompanyId_idx" ON "Contract"("buyerCompanyId");

-- CreateIndex
CREATE INDEX "Contract_status_nextDueTick_idx" ON "Contract"("status", "nextDueTick");

-- CreateIndex
CREATE INDEX "Loan_borrowerType_borrowerId_idx" ON "Loan"("borrowerType", "borrowerId");

-- CreateIndex
CREATE INDEX "Loan_status_nextDueTick_idx" ON "Loan"("status", "nextDueTick");

-- CreateIndex
CREATE INDEX "Proposal_scopeType_scopeId_status_idx" ON "Proposal"("scopeType", "scopeId", "status");

-- CreateIndex
CREATE INDEX "ResearchProject_companyId_idx" ON "ResearchProject"("companyId");

-- CreateIndex
CREATE INDEX "ResearchProject_status_idx" ON "ResearchProject"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Patent_techId_key" ON "Patent"("techId");

-- CreateIndex
CREATE UNIQUE INDEX "Alliance_name_key" ON "Alliance"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AllianceMember_userId_key" ON "AllianceMember"("userId");

-- CreateIndex
CREATE INDEX "AllianceInvite_userId_status_idx" ON "AllianceInvite"("userId", "status");

-- CreateIndex
CREATE INDEX "ChatMessage_channel_id_idx" ON "ChatMessage"("channel", "id");

-- CreateIndex
CREATE INDEX "Notification_userId_id_idx" ON "Notification"("userId", "id");

-- CreateIndex
CREATE INDEX "WorldEvent_tick_idx" ON "WorldEvent"("tick");

-- CreateIndex
CREATE INDEX "WorldEvent_cityId_id_idx" ON "WorldEvent"("cityId", "id");

-- CreateIndex
CREATE INDEX "AuditLog_userId_id_idx" ON "AuditLog"("userId", "id");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
