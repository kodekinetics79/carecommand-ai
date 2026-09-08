-- Transactional appointment messages must not wake patients overnight. These
-- conservative defaults apply to existing tenants and remain tenant-editable.
ALTER TABLE "SchedulingPolicy"
  ADD COLUMN "communicationQuietHoursStart" TEXT NOT NULL DEFAULT '20:00',
  ADD COLUMN "communicationQuietHoursEnd" TEXT NOT NULL DEFAULT '08:00';

ALTER TABLE "SchedulingPolicy"
  ADD CONSTRAINT "SchedulingPolicy_communication_quiet_hours_format_check"
  CHECK (
    "communicationQuietHoursStart" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "communicationQuietHoursEnd" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "communicationQuietHoursStart" <> "communicationQuietHoursEnd"
  );
