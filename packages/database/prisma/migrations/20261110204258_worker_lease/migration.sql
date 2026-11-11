-- CreateTable
CREATE TABLE "WorkerLease" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerLease_pkey" PRIMARY KEY ("id")
);
