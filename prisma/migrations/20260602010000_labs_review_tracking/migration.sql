-- AlterTable
ALTER TABLE "PartnerReport" ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByUserId" UUID;

-- AddForeignKey
ALTER TABLE "PartnerReport" ADD CONSTRAINT "PartnerReport_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
