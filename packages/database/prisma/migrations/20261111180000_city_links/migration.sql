-- Магистрали между градовете
CREATE TABLE "CityLink" (
    "id" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "builtById" TEXT NOT NULL,
    "length" INTEGER NOT NULL,
    "cost" BIGINT NOT NULL,
    "createdTick" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CityLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CityLink_order_check" CHECK ("aId" < "bId"),
    CONSTRAINT "CityLink_cost_check" CHECK ("cost" >= 0 AND "length" > 0)
);

CREATE UNIQUE INDEX "CityLink_aId_bId_key" ON "CityLink"("aId", "bId");
CREATE INDEX "CityLink_bId_idx" ON "CityLink"("bId");

ALTER TABLE "CityLink" ADD CONSTRAINT "CityLink_aId_fkey" FOREIGN KEY ("aId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CityLink" ADD CONSTRAINT "CityLink_bId_fkey" FOREIGN KEY ("bId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;
