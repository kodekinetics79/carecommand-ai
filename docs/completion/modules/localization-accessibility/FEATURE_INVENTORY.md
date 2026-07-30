# M22 Localization, Preferences and Accessibility — Feature Inventory

Pod: Experience Pod. Embedded consultant: WCAG/assistive-technology/localization consultant. Independent reviewer: independent accessibility auditor. Data: INTERNAL preference data; translated PHI is prohibited by default. Dependencies: M01-M03, M10, M23.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M22-F01 | Language catalog/translation gateway | Public/staff/patient; list/translate/off/timeout/cache | AutoTranslate; i18n APIs | translation providers/cache | no runtime PHI translation, rate limit, truthful provider, cache safety | Translation privacy tests pass; approved provider/language QA external | IN DISCOVERY |
| M22-F02 | Currency/language/customer preferences | Staff/admin; list/create/edit/delete/invalid | `/settings`; preferences APIs | `CustomerPreference` | settings permissions, tenant scope, audit, no default demo locale | Routes/crawl exist; persistence/browser/role tests incomplete | IN DISCOVERY |
| M22-F03 | UI shell preferences | Staff; sidebar collapse/sections, reload/malformed local state | Sidebar/uiPrefs | browser-local non-PHI | no security decision from local state, keyboard/ARIA | E2E mobile route crawl selected; focused accessibility/storage tests missing | IN DISCOVERY |
| M22-F04 | Responsive/mobile behavior | Staff/patient/platform; nav/open/close/forms/tables | all React surfaces | none | no hidden authorization; accessible touch targets | Pixel 7 E2E `10/10` baseline; module/feature-specific mobile coverage incomplete | IN DISCOVERY |
| M22-F05 | WCAG/assistive technology | All users; keyboard, focus, name/role/value, contrast, errors | design system/all pages | none | WCAG 2.2 target, semantic status/errors, no color-only meaning | Route crawl catches selected structural defects; formal WCAG/AT audit external | EXTERNAL BLOCKED |

