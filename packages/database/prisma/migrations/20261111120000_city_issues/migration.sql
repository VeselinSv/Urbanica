-- Сигнали от гражданите за проблеми в града
CREATE TABLE "CityIssue" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reporter" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdTick" INTEGER NOT NULL,
    "fixDoneTick" INTEGER,
    "resolvedTick" INTEGER,
    "resolvedBy" TEXT,
    "cost" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "CityIssue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CityIssue_severity_check" CHECK ("severity" BETWEEN 1 AND 3),
    CONSTRAINT "CityIssue_status_check" CHECK ("status" IN ('OPEN', 'FIXING', 'RESOLVED')),
    CONSTRAINT "CityIssue_cost_check" CHECK ("cost" >= 0)
);

CREATE INDEX "CityIssue_cityId_status_idx" ON "CityIssue"("cityId", "status");
CREATE UNIQUE INDEX "CityIssue_cityId_kind_x_y_createdTick_key" ON "CityIssue"("cityId", "kind", "x", "y", "createdTick");

ALTER TABLE "CityIssue" ADD CONSTRAINT "CityIssue_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;
