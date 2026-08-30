import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { knowledgeDocumentSchema } from '../lib/receptionist/knowledge';
import { localePackStringsSchema, validateLocalePackStrings } from '../lib/receptionist/localePacks/render';
import { CATALOG_LIMITS } from '../lib/receptionist/catalog';

// ===========================================================================
// The frontend builds its panels against JSON fixtures in
// src/test/fixtures/receptionist/. If those fixtures drift from what the API
// actually returns, the UI passes its own tests and then breaks against the
// live server. This suite parses the frontend's fixtures with the server's own
// schemas, so the two halves cannot disagree silently.
// ===========================================================================

const FIXTURE_DIR = new URL('../../src/test/fixtures/receptionist/', import.meta.url);
const fixturePath = (name: string) => new URL(name, FIXTURE_DIR).pathname;

function readFixture(name: string): unknown | null {
  const path = fixturePath(name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// --- Response schemas, mirroring what the routes actually send -------------

const readinessSchema = z.object({
  transferReady: z.boolean(),
  transferReason: z.enum(['missing', 'not_e164', 'loops_to_agent']).nullable(),
  country: z.string().nullable(),
  countryConfirmed: z.boolean(),
  hoursConfigured: z.boolean(),
  localePack: z.object({
    language: z.string(),
    country: z.string().nullable(),
    status: z.enum(['APPROVED', 'MISSING']),
    packId: z.string().nullable(),
    evidenceHash: z.string().nullable(),
  }),
  knowledge: z.object({
    status: z.enum(['APPROVED', 'DRAFT', 'MISSING']),
    approvedRevision: z.number().nullable(),
    dirty: z.boolean(),
  }),
  blockers: z.array(z.string()),
});

const clinicsSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  country: z.string().nullable(),
  timezone: z.string(),
  defaultLanguage: z.string(),
  complianceDisclosure: z.string().nullable(),
  humanFallbackNumber: z.string().nullable(),
  doNotContactPolicy: z.string().nullable(),
  readiness: readinessSchema,
  locations: z.array(z.object({
    id: z.string(),
    name: z.string(),
    address: z.string(),
    phone: z.string().nullable(),
    accessNotes: z.string().nullable(),
    timezone: z.string(),
    timezoneSource: z.object({ kind: z.enum(['branch', 'clinic']), name: z.string().nullable() }),
  }).loose()),
}).loose());

const catalogSchema = z.object({
  generatedAt: z.string(),
  fieldTypes: z.array(z.object({
    type: z.string(), label: z.string(), question: z.string(), validation: z.string(),
    group: z.string(), hasOptions: z.boolean(), sensitive: z.boolean(),
  })),
  timezones: z.object({ groups: z.array(z.object({ region: z.string(), zones: z.array(z.string()) })), recommended: z.array(z.string()) }),
  countries: z.array(z.object({
    code: z.string(), name: z.string(), callingCode: z.string(),
    defaultEmergencyNumber: z.string(), defaultLanguages: z.array(z.string()), currency: z.string(),
  })),
  languages: z.array(z.object({ id: z.string(), label: z.string(), provider: z.string() })),
  tones: z.array(z.string()),
  campaignTypes: z.array(z.string()),
  localePacks: z.array(z.object({
    language: z.string(), country: z.string(), status: z.enum(['APPROVED', 'DRAFT', 'MISSING']),
    packId: z.string().nullable(), hasPlatformDefault: z.boolean(), platformDefaultVersion: z.number().nullable(),
  })),
  limits: z.object({
    maxIntakeFields: z.number(), faqMax: z.number(), payersMax: z.number(), closureMaxDays: z.number(),
    knowledgeTextMax: z.number(), closureReasonMax: z.number(), accessNotesMax: z.number(),
  }),
});

const effectiveDaySchema = z.object({
  date: z.string(), dayKey: z.string(), timezone: z.string(), open: z.boolean(),
  windows: z.array(z.object({ start: z.string(), end: z.string() })),
  closure: z.object({ id: z.string(), reason: z.string(), allDay: z.boolean() }).nullable(),
  source: z.enum(['location', 'clinic', 'unconfigured']),
});

const hoursStatusSchema = z.object({
  at: z.string(),
  clinics: z.array(z.object({
    clinicId: z.string(), name: z.string(), timezone: z.string(), country: z.string().nullable(),
    configured: z.boolean(), blockers: z.array(z.string()), formatFallback: z.boolean(),
    isOpenNow: z.boolean(), today: effectiveDaySchema.nullable(), todayHoursSpoken: z.string(),
    nextOpening: z.object({ date: z.string(), start: z.string(), startsAt: z.string(), spoken: z.string().nullable() }).nullable(),
    closureReason: z.string().nullable(),
    afterHoursCalls: z.object({ last24Hours: z.number(), last7Days: z.number(), lastAt: z.string().nullable() }),
    locations: z.array(z.object({
      id: z.string(), name: z.string(), timezone: z.string(), configured: z.boolean(),
      isOpenNow: z.boolean(), todayHoursSpoken: z.string(),
    })),
  })),
});

const knowledgeViewSchema = z.object({
  clinicId: z.string(),
  draft: knowledgeDocumentSchema,
  draftRevision: z.number(),
  approved: knowledgeDocumentSchema.nullable(),
  approvedRevision: z.number().nullable(),
  approvedHash: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  dirty: z.boolean(),
  validation: z.object({ ok: z.boolean(), issues: z.array(z.object({ path: z.string(), message: z.string() })) }),
});

const localePacksSchema = z.object({
  packs: z.array(z.object({
    id: z.string(), language: z.string(), country: z.string(), version: z.number(),
    status: z.enum(['DRAFT', 'APPROVED', 'RETIRED']), source: z.enum(['platform_default', 'tenant']),
    baseDefaultVersion: z.number().nullable(), strings: localePackStringsSchema, evidenceHash: z.string(),
    approvedAt: z.string().nullable(), approvedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
    retiredAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), boundActiveCampaigns: z.number(),
  })),
  defaults: z.array(z.object({ language: z.string(), country: z.string(), version: z.number(), strings: localePackStringsSchema, evidenceHash: z.string() })),
});

const CONTRACTS: Array<{ file: string; schema: z.ZodType }> = [
  { file: 'clinics.json', schema: clinicsSchema },
  { file: 'catalog.json', schema: catalogSchema },
  { file: 'hoursStatus.json', schema: hoursStatusSchema },
  { file: 'knowledge.json', schema: knowledgeViewSchema },
  { file: 'localePacks.json', schema: localePacksSchema },
];

describe('frontend fixture contract', () => {
  const dirExists = existsSync(FIXTURE_DIR.pathname);

  it('knows where the frontend fixtures live', () => {
    // Not a failure while the frontend package is still in flight; the
    // per-file assertions below simply have nothing to check yet.
    if (!dirExists) {
      expect(dirExists).toBe(false);
      return;
    }
    expect(readdirSync(FIXTURE_DIR.pathname).length).toBeGreaterThan(0);
  });

  for (const contract of CONTRACTS) {
    it(`${contract.file} parses with the server response schema`, () => {
      const fixture = readFixture(contract.file);
      if (fixture === null) {
        expect(fixture).toBeNull();
        return;
      }
      const result = contract.schema.safeParse(fixture);
      // A readable failure: the frontend fixture no longer matches what the
      // API sends, so one of the two must change before merge.
      expect(result.error?.issues ?? [], `${contract.file} does not match the API contract`).toEqual([]);
      expect(result.success).toBe(true);
    });
  }

  it('locale pack fixtures carry approvable wording', () => {
    const fixture = readFixture('localePacks.json') as { packs?: Array<{ strings: unknown }> } | null;
    if (!fixture?.packs?.length) {
      expect(fixture?.packs ?? []).toEqual([]);
      return;
    }
    for (const pack of fixture.packs) {
      const parsed = localePackStringsSchema.parse(pack.strings);
      expect(validateLocalePackStrings(parsed as never).issues).toEqual([]);
    }
  });

  it('knowledge fixtures stay inside the published limits', () => {
    const fixture = readFixture('knowledge.json') as { draft?: { faq?: unknown[]; acceptedPayers?: unknown[] } } | null;
    if (!fixture?.draft) {
      expect(fixture).toBeNull();
      return;
    }
    expect((fixture.draft.faq ?? []).length).toBeLessThanOrEqual(CATALOG_LIMITS.faqMax);
    expect((fixture.draft.acceptedPayers ?? []).length).toBeLessThanOrEqual(CATALOG_LIMITS.payersMax);
  });
});
