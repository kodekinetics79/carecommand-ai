-- CRM engine: explicit approval_required + failed campaign statuses.
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'APPROVAL_REQUIRED';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'FAILED';
