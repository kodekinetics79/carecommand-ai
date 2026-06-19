-- CreateTable
CREATE TABLE "TranslationCache" (
    "id" UUID NOT NULL,
    "targetLang" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "translatedText" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TranslationCache_targetLang_idx" ON "TranslationCache"("targetLang");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationCache_targetLang_sourceHash_key" ON "TranslationCache"("targetLang", "sourceHash");
