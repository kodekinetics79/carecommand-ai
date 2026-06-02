-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastAgentMessage" TEXT,
ADD COLUMN     "lastAgentMessageAt" TIMESTAMP(3);
