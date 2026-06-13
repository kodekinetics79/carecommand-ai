-- Appointment Checkout: patient-safe tokenized public status + optional link expiry.
ALTER TABLE "PaymentRequest" ADD COLUMN "publicToken" UUID;
ALTER TABLE "PaymentRequest" ADD COLUMN "linkExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "PaymentRequest_publicToken_key" ON "PaymentRequest"("publicToken");
