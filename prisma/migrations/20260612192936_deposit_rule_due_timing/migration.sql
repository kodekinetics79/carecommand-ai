-- Deposit rule due timing: at_booking | before_visit | manual.
ALTER TABLE "DepositRule" ADD COLUMN "dueTiming" TEXT NOT NULL DEFAULT 'at_booking';
