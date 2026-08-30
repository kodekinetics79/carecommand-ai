import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './localePacks/render';
import { promptText } from './promptSafety';

// ===========================================================================
// Clinic knowledge document: what the receptionist may say about insurance,
// payment, new patients, urgent care and the approved FAQ. Services are NOT
// here: ServiceCatalogItem is the single source of truth (contract §4).
// ===========================================================================

export interface KnowledgeDocument {
  acceptedPayers: Array<{ id: string; name: string; plans?: string[]; note?: string; source: 'manual'; verifiedAt?: string }>;
  paymentPolicy: string;
  newPatientPolicy: string;
  urgentCare: { whatCountsAsUrgent: string; sameDayPolicy: string; onCallNumber: string | null };
  faq: Array<{ id: string; question: string; answer: string; approvedByUserId?: string; approvedAt?: string }>;
}

export const KNOWLEDGE_LIMITS = { payersMax: 60, plansPerPayerMax: 10, faqMax: 50, textMax: 600 } as const;

const E164 = /^\+[1-9]\d{7,14}$/;
const uuid = z.string().uuid();

/** Structural + sanitising schema for PUT. Content rules (validateKnowledge) gate approval. */
export const knowledgeDocumentSchema = z.object({
  acceptedPayers: z.array(z.object({
    id: uuid,
    name: promptText(120),
    plans: z.array(promptText(80)).max(KNOWLEDGE_LIMITS.plansPerPayerMax).optional(),
    note: promptText(200).optional(),
    source: z.literal('manual'),
    verifiedAt: z.string().datetime().optional(),
  }).strict()).max(KNOWLEDGE_LIMITS.payersMax),
  paymentPolicy: promptText(KNOWLEDGE_LIMITS.textMax),
  newPatientPolicy: promptText(KNOWLEDGE_LIMITS.textMax),
  urgentCare: z.object({
    whatCountsAsUrgent: promptText(KNOWLEDGE_LIMITS.textMax),
    sameDayPolicy: promptText(KNOWLEDGE_LIMITS.textMax),
    onCallNumber: z.preprocess(
      value => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.replace(/[().\s-]/g, '') : value),
      z.string().regex(E164, 'On-call number must be E.164').nullable(),
    ),
  }).strict(),
  faq: z.array(z.object({
    id: uuid,
    question: promptText(200),
    answer: promptText(KNOWLEDGE_LIMITS.textMax),
    approvedByUserId: uuid.optional(),
    approvedAt: z.string().datetime().optional(),
  }).strict()).max(KNOWLEDGE_LIMITS.faqMax),
}).strict();

export function emptyKnowledgeDocument(): KnowledgeDocument {
  return {
    acceptedPayers: [],
    paymentPolicy: '',
    newPatientPolicy: '',
    urgentCare: { whatCountsAsUrgent: '', sameDayPolicy: '', onCallNumber: null },
    faq: [],
  };
}

export interface KnowledgeIssue { path: string; message: string }

/** Content rules that must hold before the document can be approved. */
export function validateKnowledge(doc: KnowledgeDocument): { ok: boolean; issues: KnowledgeIssue[] } {
  const issues: KnowledgeIssue[] = [];
  const seen = new Set<string>();
  doc.acceptedPayers.forEach((payer, index) => {
    const key = payer.name.trim().toLowerCase();
    if (!key) issues.push({ path: `acceptedPayers.${index}.name`, message: 'Payer name is required' });
    else if (seen.has(key)) issues.push({ path: `acceptedPayers.${index}.name`, message: 'Duplicate payer name' });
    seen.add(key);
  });
  doc.faq.forEach((item, index) => {
    if (!item.question.trim()) issues.push({ path: `faq.${index}.question`, message: 'Question is required' });
    if (!item.answer.trim()) issues.push({ path: `faq.${index}.answer`, message: 'Answer is required' });
  });
  if (doc.urgentCare.onCallNumber && !E164.test(doc.urgentCare.onCallNumber)) issues.push({ path: 'urgentCare.onCallNumber', message: 'On-call number must include the country code, like +1 212 555 0100' });
  const hasAnyContent = doc.acceptedPayers.length > 0 || doc.paymentPolicy.trim() || doc.newPatientPolicy.trim()
    || doc.urgentCare.whatCountsAsUrgent.trim() || doc.urgentCare.sameDayPolicy.trim() || doc.faq.length > 0;
  if (!hasAnyContent) issues.push({ path: '', message: 'The document is empty; add at least one fact before approving' });
  return { ok: issues.length === 0, issues };
}

/** Runtime guard for JSON read back from the database (approved snapshots). */
export function parseKnowledgeDocument(value: unknown): KnowledgeDocument | null {
  const parsed = knowledgeDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data as KnowledgeDocument : null;
}

export function knowledgeHash(doc: KnowledgeDocument): string {
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}
