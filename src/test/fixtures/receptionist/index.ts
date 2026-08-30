import type { Catalog, ClinicRow, Closure, HoursStatusView, KnowledgeView, LocalePacksResponse } from '../../../lib/receptionistClinic';
import catalogRaw from './catalog.json?raw';
import clinicsRaw from './clinics.json?raw';
import closuresRaw from './closures.json?raw';
import hoursStatusRaw from './hoursStatus.json?raw';
import knowledgeRaw from './knowledge.json?raw';
import localePacksRaw from './localePacks.json?raw';

/**
 * The C2 contract fixtures. The JSON files are the artefact both halves
 * share: jsdom tests read them here, and the backend's contract test parses
 * the same files with its response Zod schemas. Each call returns a fresh
 * object so a test that mutates its copy cannot leak into the next one.
 */
export const receptionistFixtures = {
  catalog: (): Catalog => JSON.parse(catalogRaw) as Catalog,
  clinics: (): ClinicRow[] => JSON.parse(clinicsRaw) as ClinicRow[],
  closures: (): Closure[] => JSON.parse(closuresRaw) as Closure[],
  hoursStatus: (): HoursStatusView => JSON.parse(hoursStatusRaw) as HoursStatusView,
  knowledge: (): KnowledgeView => JSON.parse(knowledgeRaw) as KnowledgeView,
  localePacks: (): LocalePacksResponse => JSON.parse(localePacksRaw) as LocalePacksResponse,
};
