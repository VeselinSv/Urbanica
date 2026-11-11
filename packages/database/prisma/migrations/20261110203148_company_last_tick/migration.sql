-- AlterTable
ALTER TABLE "City" ALTER COLUMN "lastTick" SET DEFAULT -1;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "lastTick" INTEGER NOT NULL DEFAULT -1;
