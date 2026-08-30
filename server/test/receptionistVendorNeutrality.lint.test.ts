import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// ===========================================================================
// A tenant sees CareCommand, not our suppliers.
//
// Before this ratchet the browser bundle contained 200 mentions of one voice
// supplier, 33 of a speech vendor, and named identifiers down to agent ids and
// dynamic-variable tags, across 33 tenant-facing files.
//
// Two reasons that is a defect and not a matter of taste:
//
//   · commercially, a clinic that can read the stack off its own screen can
//     price us against going direct;
//   · operationally, none of it is actionable by the reader. A clinic owner
//     cannot open a supplier's console, rotate a supplier's key, or assign a
//     version tag. Printing those instructions turned a support ticket into a
//     dead end with our supplier's name on it.
//
// ---------------------------------------------------------------------------
// THE PREMISE THIS TEST USED TO HOLD, AND WHY IT WAS WRONG
// ---------------------------------------------------------------------------
//
// This file used to scan `src/` and nothing else, on a premise written into
// its own header: "the rule is about what a TENANT reads, and the tenant reads
// `src/`". `server/` was declared exempt wholesale, as audit copy, log lines,
// provider adapters and migration comments.
//
// The tenant does not read `src/`. The tenant reads whatever the API sends,
// and this codebase deliberately authors operator-facing sentences on the
// server: `remediation.ts` alone writes 60+ of them, and `campaignReadiness.ts`
// writes the `label` and `detail` of every row on the go-live checklist.
// `ReadinessChecklist.tsx` renders both verbatim, and
// `GET /campaigns/:id/readiness` is a tenant route.
//
// So the scan that was supposed to remove suppliers from the clinic's screen
// watched the half of the product that did not write them. Eighteen supplier
// mentions sat in tenant response bodies — thirteen on the go-live checklist,
// four on the deploy failure response, one on the verify response — through
// the entire life of the branch whose commit message was "the clinic sees
// capabilities, not a console of suppliers". `remediation.ts` was clean only
// by luck of discipline: its supplier sentences live on `platformAction`,
// which `remediationFor()` destructures out before the response is built.
// `campaignReadiness.ts` had no such discipline and nothing was watching.
//
// ---------------------------------------------------------------------------
// THE BOUNDARY, RESTATED
// ---------------------------------------------------------------------------
//
// The boundary is not `src/` versus `server/`. It is WHAT REACHES A TENANT
// RESPONSE BODY. So this file now runs two scans:
//
//   1. `src/`, by line. Everything in the browser bundle is, sooner or later,
//      on a clinic's screen.
//   2. `server/lib/receptionist/**` and `server/modules/receptionist/**`, by
//      FIELD. A TypeScript parse finds the string literals that become
//      `label`, `detail`, `title`, `action`, `message`, `reason` and `summary`
//      — the seven fields the receptionist API serialises as operator copy —
//      and only those are checked.
//
// Field direction is what makes scanning the server tractable, and it is also
// what keeps the genuinely-exempt categories exempt WITHOUT an allowlist:
//
//   · comments (including migration notes) are not string literals, so the
//     parser never yields them;
//   · log lines, URLs, HTTP headers, env var names, provider request payloads
//     and adapter function names are not tenant fields, so they are not read;
//   · audit copy is exempt by SINK — see `EXEMPT_SINKS`, where an audit row's
//     `action` is a database verb rather than a sentence anybody reads;
//   · platform-only fields are exempt by NAME — `platformAction` is the whole
//     re-addressing design and is never propagated into.
//
// Note what is deliberately NOT exempt: a provider adapter. `retellDeploy.ts`
// is as adapter as a file gets, and four of the eighteen leaks were in it,
// because its `fail(code, message)` sentences are serialised onto the tenant's
// deploy response. Exempting adapters by filename would have re-hidden them.
// An adapter may name the supplier everywhere except the seven fields.
//
// ---------------------------------------------------------------------------
// RATCHET DISCIPLINE — unchanged, and now applied to both scans
// ---------------------------------------------------------------------------
//
//   · a banned word outside the allowlist fails the suite;
//   · each allowlist is a CEILING, asserted below, and every entry states the
//     reason it exists — entries may be deleted, never added;
//   · a line that genuinely must keep a vendor token carries an inline
//     `vendor-neutral-exempt` marker, and the NUMBER of those may only fall.
//
// And one addition, because this scan has a mechanism the line-based one does
// not: `it('resolves the two shapes that hid the leak')` scans a fixture and
// asserts the resolver still follows a positional argument to its parameter
// name and an identifier to its label map. Those are the two shapes that let
// eighteen mentions through a grep. If a refactor breaks the resolver, that
// test fails loudly rather than this file going quietly green.
// ===========================================================================

const SRC = resolve(process.cwd(), 'src');

/**
 * Vendor names. Lower-cased comparison, so `RetellAI`, `Retell` and
 * `retell_call_id` all match the same entry.
 */
const VENDOR_WORDS = ['retell', 'retellai', 'twilio', '11labs', 'elevenlabs', 'stedi', 'sendgrid'] as const;

/**
 * Provider identifier SHAPES. A file can be scrubbed of vendor names and still
 * hand a clinic the supplier's data model — `RETELL_API_KEY` was caught by the
 * word list, but `agent_9f2c…` and a raw `llm_…` id would not be.
 */
// Hex suffixes only, and at least 12 of them. `agent_unlinked`,
// `agent_verified` and `call_analyzed` are OUR words — readiness keys and
// webhook event names — and a pattern that flags them is a pattern people
// learn to ignore.
const IDENTIFIER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'provider agent id', pattern: /\bagent_[a-f0-9]{12,}\b/gi },
  { name: 'provider response-engine id', pattern: /\bllm_[a-f0-9]{12,}\b/gi },
  { name: 'provider call id', pattern: /\bcall_[a-f0-9]{12,}\b/gi },
  { name: 'provider credential env var', pattern: /\b[A-Z][A-Z0-9]{2,}_(?:API_KEY|AUTH_TOKEN|ACCOUNT_SID|FROM_NUMBER)\b/g },
];

/**
 * Files that may name a vendor, each with the reason it may.
 *
 * This list is a ceiling. It shrinks when a surface stops being an exception —
 * the eligibility rows go when eligibility becomes CareCommand-supplied the way
 * the voice line is, and the exemption markers go as the last identifiers move
 * behind the platform boundary. Nothing is added without deleting something.
 */
const ALLOWLIST: Record<string, string> = {
  // --- Platform-only surfaces ---------------------------------------------
  // Rendered behind the platform JWT, which a tenant token cannot mint. This is
  // where the mechanics the tenant no longer receives are supposed to land.
  'src/pages/PlatformConsole.tsx':
    'Platform Console. Operators must see supplier identities, credential field names and raw provider payloads — that is the point of moving them here.',

  // --- Services the CLINIC contracts and configures itself -----------------
  //
  // 2026-08-30: this section is EMPTY, and that is the point of the ratchet.
  //
  // Four screens lived here on the argument that the clinic holds the account
  // and therefore has to be told which one: the clearinghouse selector on
  // Insurance, the provider strip on InsuranceEligibility, the credential
  // fields on IntegrationSetup, and the Mock Mode explainer on
  // RevenueProtection. The argument does not survive contact with a practice
  // manager. None of them holds a clearinghouse contract, none can rotate a
  // card-processor key, and every one of those screens ended in a support
  // ticket with a supplier's name on it.
  //
  // All four now state a CAPABILITY and name us as the next step —
  // "Card payments: not set up. Contact CareCommand support to switch it on."
  // IntegrationSetup was deleted outright; the catalogue, the credential
  // fields and the health checks are Platform Console surfaces.
};

/** Lines that keep a vendor token for a stated, structural reason. */
const EXEMPT_MARKER = 'vendor-neutral-exempt';

/**
 * The exemption ceiling. Same ratchet discipline as the allowlist: this number
 * may fall and may never rise.
 */
const MAX_EXEMPT_LINES = 2;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (/\.(ts|tsx|css|html|json)$/.test(entry)) found.push(full);
  }
  return found;
}

interface Offence { file: string; line: number; text: string; reason: string }

function offencesIn(text: string): string[] {
  const found: string[] = [];
  const lowered = text.toLowerCase();
  for (const word of VENDOR_WORDS) if (lowered.includes(word)) found.push(`vendor name "${word}"`);
  for (const { name, pattern } of IDENTIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

function scan(file: string): { offences: Offence[]; exempt: number } {
  const relativePath = relative(process.cwd(), file).split(sep).join('/');
  const offences: Offence[] = [];
  let exempt = 0;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes(EXEMPT_MARKER)) { exempt += 1; return; }
    const [reason] = offencesIn(line);
    if (reason) offences.push({ file: relativePath, line: index + 1, text: line.trim().slice(0, 140), reason });
  });
  return { offences, exempt };
}

// ===========================================================================
// The server half: server-authored copy that reaches a tenant response body.
// ===========================================================================

/** Where the receptionist API authors sentences an operator reads. */
const SERVER_COPY_ROOTS = ['server/lib/receptionist', 'server/modules/receptionist'];

/**
 * The seven fields the receptionist API serialises as operator copy.
 *
 * `label`, `detail` and `title` are the readiness checklist rows. `action` is
 * the remediation catalogue's tenant half. `message` is every 4xx/5xx body the
 * receptionist routes send, plus `retellDeploy`'s `fail()`. `reason` is the
 * activation and admission refusals. `summary` is the hours and closure lines
 * the Clinic Profile reads back.
 */
const TENANT_FIELDS = new Set(['label', 'detail', 'title', 'action', 'message', 'reason', 'summary']);

/**
 * Exempt BY FIELD NAME, everywhere and unconditionally. Re-addressing the
 * precise, supplier-named instruction to Platform Admin is the design
 * (`remediation.ts`), not a leak: `remediationFor()` destructures
 * `platformAction` out, and `platformRemediationFor()` — reachable only behind
 * the platform JWT — is the only way to read it. The scanner never propagates
 * into one, so a catalogue entry may hold both halves side by side.
 */
const PLATFORM_ONLY_FIELDS = new Set(['platformAction']);

/**
 * Exempt BY SINK: calls whose arguments are database rows or log records
 * rather than sentences a tenant reads. Each states the reason it is here.
 *
 * Note how narrow this is. `staffTask.create` and `operationalSignal.upsert`
 * are Prisma writes too and are deliberately NOT exempt — a task title is on
 * the Front Desk board, which is the most-read screen in the product.
 */
const EXEMPT_SINKS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\.)auditEvent\.(create|createMany|count)$/, reason: 'the audit log. `action` is a database verb ("receptionistAgent.deployFailed"), and compliance evidence has to stay precise — a DPO asks for this row by name.' },
  { pattern: /(^|\.)receptionistArtifactLifecycleEvent\.create$/, reason: 'the retention ledger. `action` is a lifecycle state (PURGE_REQUESTED, VENDOR_DELETE_REQUESTED), and the supplier a delete was requested FROM is the point of the record.' },
  { pattern: /^(audit|auditLive|auditHandoff|auditReceptionistMutation|auditOutboundMutation|writeAudit)$/, reason: 'audit helpers. Every one takes an `action` verb and forwards it to auditEvent.create; exempting the helper and not just the table keeps the reason readable at the call site.' },
  { pattern: /(^|\.)(log|logger|req\.log|request\.log|app\.log)\.(info|warn|error|debug|trace|fatal)$/, reason: 'log lines. A log that will not say which API returned a 429 is a worse log line, and nobody outside CareCommand reads one.' },
];

interface TenantString { file: string; line: number; text: string; via: string }

/**
 * Every string literal that reaches one of the seven tenant fields.
 *
 * Two shapes matter, and BOTH are shapes a grep for `detail:` would miss —
 * which is exactly how eighteen supplier mentions survived:
 *
 *   1. POSITIONAL ARGUMENTS. `campaignReadiness.ts` writes its rows as
 *      `check(key, status, detail, ctx, code)`. The word "detail" appears once,
 *      in the signature. So the resolver reads the callee's parameter names and
 *      taints the argument sitting at a tenant-field position.
 *   2. COPY MAPS. `LABELS[key]` is the value of `label:`, but the literals live
 *      in an object whose keys are readiness ids. So an identifier reached from
 *      a tenant field is followed to its declaration and expanded.
 *
 * Propagation runs "deep" from a tenant-field seed (through identifiers,
 * object and array literals, member access) and "shallow" inside a template
 * span (literal shapes only). Shallow spans catch an inline
 * `${flag ? 'Retell says' : 'ok'}` without tainting every symbol a template
 * happens to interpolate.
 */
export function tenantFacingStrings(fileName: string, text: string): TenantString[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const relativePath = relative(process.cwd(), fileName).split(sep).join('/');
  const found: TenantString[] = [];
  const visited = new Set<ts.Node>();

  const nameOf = (node: ts.PropertyName): string => node.getText(src).replace(/^['"`]|['"`]$/g, '');

  // Parameter names by function name, so a positional argument can be resolved
  // to the field it becomes.
  const signatures = new Map<string, string[]>();
  const record = (name: string | undefined, fn: ts.SignatureDeclarationBase) => {
    if (name) signatures.set(name, fn.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : '')));
  };
  // Top-level and local `const` initialisers, so a copy map or an extracted
  // sentence can be followed from where it is used to where it is written.
  const declarations = new Map<string, ts.Expression>();
  const index = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) record(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) record(node.name.text, node.initializer);
    }
    ts.forEachChild(node, index);
  };
  index(src);

  const keep = (node: ts.Node, value: string, via: string) => {
    found.push({ file: relativePath, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, text: value, via });
  };

  const taint = (node: ts.Expression | undefined, via: string, deep: boolean): void => {
    if (!node || visited.has(node)) return;
    visited.add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return keep(node, node.text, via);
    if (ts.isTemplateExpression(node)) {
      keep(node.head, node.head.text, via);
      for (const span of node.templateSpans) {
        keep(span.literal, span.literal.text, via);
        taint(span.expression, via, false);
      }
      return;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return taint(node.expression, via, deep);
    if (ts.isConditionalExpression(node)) { taint(node.whenTrue, via, deep); taint(node.whenFalse, via, deep); return; }
    if (ts.isBinaryExpression(node)
      && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      taint(node.left, via, deep); taint(node.right, via, deep); return;
    }
    if (!deep) return;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && !PLATFORM_ONLY_FIELDS.has(nameOf(property.name))) taint(property.initializer, via, deep);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) { for (const element of node.elements) taint(element, via, deep); return; }
    if (ts.isIdentifier(node)) {
      const initializer = declarations.get(node.text);
      if (initializer) taint(initializer, `${via} → ${node.text}`, deep);
      return;
    }
    // `LABELS[key]` / `remediation.title`: follow to the thing being indexed.
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) return taint(node.expression, via, deep);
  };

  const exemptSink = (node: ts.Node): boolean => {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (!ts.isCallExpression(parent)) continue;
      const callee = parent.expression.getText(src);
      if (EXEMPT_SINKS.some(sink => sink.pattern.test(callee))) return true;
    }
    return false;
  };

  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && TENANT_FIELDS.has(nameOf(node.name)) && !exemptSink(node)) {
      taint(node.initializer, `${nameOf(node.name)}:`, true);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !exemptSink(node)) {
      const parameters = signatures.get(node.expression.text);
      if (parameters) {
        node.arguments.forEach((argument, position) => {
          const parameter = parameters[position] ?? '';
          if (TENANT_FIELDS.has(parameter)) taint(argument, `${node.expression.getText(src)}(${parameter})`, true);
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
  return found;
}

function serverCopyFiles(): string[] {
  const found: string[] = [];
  for (const root of SERVER_COPY_ROOTS) {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) found.push(full);
      }
    };
    walk(resolve(process.cwd(), root));
  }
  return found;
}

function scanServerCopy(): { offences: Offence[]; exempt: number; scanned: number } {
  const offences: Offence[] = [];
  let exempt = 0;
  let scanned = 0;
  for (const file of serverCopyFiles()) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const row of tenantFacingStrings(file, text)) {
      scanned += 1;
      if ((lines[row.line - 1] ?? '').includes(EXEMPT_MARKER)) { exempt += 1; continue; }
      const [reason] = offencesIn(row.text);
      if (reason) offences.push({ file: row.file, line: row.line, text: `[${row.via}] ${row.text.trim().slice(0, 120)}`, reason });
    }
  }
  return { offences, exempt, scanned };
}

/**
 * Server-authored copy that may name a vendor, each with the reason it may.
 * A ceiling, like the browser one, and empty for the same reason: every entry
 * here would be a sentence a clinic reads with our supplier's name in it.
 */
const SERVER_COPY_ALLOWLIST: Record<string, string> = {};

/** The server-side exemption ceiling. Zero, and it may only stay zero or fall. */
const MAX_SERVER_EXEMPT_STRINGS = 0;

describe('the tenant sees CareCommand, not our suppliers', () => {
  it('scans a real tree', () => {
    const files = sourceFiles(SRC);
    expect(files.length, 'src/ produced no scannable files — the walker is broken, not the tree').toBeGreaterThan(100);
  });

  it('fails when a vendor name or a provider identifier reaches src/', () => {
    const offences: Offence[] = [];
    for (const file of sourceFiles(SRC)) {
      const relativePath = relative(process.cwd(), file).split(sep).join('/');
      if (ALLOWLIST[relativePath]) continue;
      offences.push(...scan(file).offences);
    }
    expect(offences, [
      'A supplier reached a tenant-facing file.',
      '',
      'The tenant vocabulary lives in ONE place — src/lib/receptionistVocabulary.ts.',
      'Import from it rather than writing a new word for the same thing.',
      '',
      'If the remediation genuinely requires action inside a supplier console,',
      'the tenant is NOT told a vaguer version of it. Put the precise',
      'instruction on the catalogue entry\'s `platformAction` in',
      'server/lib/receptionist/remediation.ts, and let the tenant read the',
      'support hand-off plus a Configuration reference.',
      '',
      'Offences:',
      ...offences.map(row => `  ${row.file}:${row.line}  (${row.reason})  ${row.text}`),
    ].join('\n')).toEqual([]);
  });

  it('keeps the allowlist a ceiling, never a target', () => {
    // Every entry states WHY, so removing one is a decision somebody can make
    // from the list itself rather than by re-deriving the argument.
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${file} is allowlisted without a reason`).toBeGreaterThan(40);
      expect(sourceFiles(SRC).map(f => relative(process.cwd(), f).split(sep).join('/')), `${file} is allowlisted but does not exist — delete the entry`).toContain(file);
    }
    expect(Object.keys(ALLOWLIST).length, 'the vendor-neutrality allowlist grew').toBeLessThanOrEqual(1);
  });

  it('keeps inline exemptions a ceiling too', () => {
    const exempt = sourceFiles(SRC).reduce((total, file) => total + scan(file).exempt, 0);
    expect(exempt, `${EXEMPT_MARKER} markers grew — a new supplier token was written into src/`).toBeLessThanOrEqual(MAX_EXEMPT_LINES);
  });

  it('reports how much supplier surface is still allowlisted', () => {
    // Not an assertion about a number, but the number itself, printed where a
    // reviewer sees it — the point of the allowlist is that it reaches zero.
    const rows = Object.keys(ALLOWLIST).map(file => {
      const { offences } = scan(resolve(process.cwd(), file));
      return `${file.split('/').pop()} ${offences.length}`;
    });
    console.log('[vendor-neutrality] allowlisted mentions remaining:', rows.join(' · '));
    expect(rows.length).toBe(Object.keys(ALLOWLIST).length);
  });
});

describe('the tenant reads the API, not just the bundle', () => {
  it('scans a real tree', () => {
    const files = serverCopyFiles();
    expect(files.length, 'the server receptionist tree produced no scannable files — the walker is broken').toBeGreaterThan(30);
    const { scanned } = scanServerCopy();
    expect(scanned, 'no tenant-facing strings resolved — the field resolver is broken, not the tree').toBeGreaterThan(400);
  });

  it('resolves the two shapes that hid the leak', () => {
    // The regression test for the RESOLVER. A grep finds neither of these, and
    // eighteen supplier mentions lived in exactly these two shapes. If a
    // refactor breaks the resolver this fails, rather than the scan above
    // silently passing on an empty result.
    const fixture = `
      const LABELS: Record<string, string> = { agent_verified: 'verified with Retell' };
      const NEUTRAL = 'nothing to see';
      function check(key: string, status: string, detail: string) {
        return { key, label: LABELS[key], status, detail };
      }
      function build(number: string, failed: boolean) {
        return check('number_bound', 'fail', failed
          ? \`Twilio reports \${number} answering elsewhere.\`
          : NEUTRAL);
      }
      const entry = { title: 'fine', platformAction: 'Rotate the Retell key.' };
      db.auditEvent.create({ data: { action: 'retell.deploy.failed' } });
    `;
    const rows = tenantFacingStrings(resolve(process.cwd(), 'fixture.ts'), fixture);
    const offending = rows.filter(row => offencesIn(row.text).length > 0).map(row => row.text);

    // 1. A copy map reached through `label: LABELS[key]`.
    expect(offending, 'the resolver stopped following an identifier to its copy map').toContain('verified with Retell');
    // 2. A POSITIONAL argument, resolved through `check`'s parameter names.
    expect(offending, 'the resolver stopped following a positional argument to its parameter name').toContain('Twilio reports ');
    // 3. What must stay exempt: the platform half, and an audit verb.
    expect(offending, '`platformAction` must never be scanned — re-addressing is the design').not.toContain('Rotate the Retell key.');
    expect(offending, 'an audit row action must stay exempt').not.toContain('retell.deploy.failed');
    // 4. And the resolver must still see ordinary tenant copy at all.
    expect(rows.map(row => row.text)).toContain('fine');
  });

  it('fails when a vendor name or a provider identifier reaches a tenant response field', () => {
    const { offences } = scanServerCopy();
    const reportable = offences.filter(row => !SERVER_COPY_ALLOWLIST[row.file]);
    expect(reportable, [
      'A supplier reached a field the tenant reads off the API.',
      '',
      'These strings become `label`, `detail`, `title`, `action`, `message`,',
      '`reason` or `summary` in a receptionist response body. The browser',
      'renders them verbatim — ReadinessChecklist.tsx prints `label` and',
      '`detail` exactly as sent — so writing a supplier name here puts it on a',
      'clinic\'s screen just as surely as writing it in src/.',
      '',
      'The tenant vocabulary lives in src/lib/receptionistVocabulary.ts and is',
      'imported by BOTH halves precisely so they cannot drift. Use it.',
      '',
      'Do NOT make the sentence vaguer to hide the supplier. If the precise',
      'instruction genuinely needs the supplier\'s name, it has a different',
      'AUDIENCE, not a shorter wording: put it on the catalogue entry\'s',
      '`platformAction` in server/lib/receptionist/remediation.ts, which',
      '`remediationFor()` destructures out of every tenant response, and leave',
      'the tenant the support hand-off plus a Configuration reference.',
      '',
      'Offences:',
      ...reportable.map(row => `  ${row.file}:${row.line}  (${row.reason})  ${row.text}`),
    ].join('\n')).toEqual([]);
  });

  it('keeps the server allowlist a ceiling, never a target', () => {
    for (const [file, reason] of Object.entries(SERVER_COPY_ALLOWLIST)) {
      expect(reason.length, `${file} is allowlisted without a reason`).toBeGreaterThan(40);
    }
    expect(Object.keys(SERVER_COPY_ALLOWLIST).length, 'the server-copy allowlist grew — a tenant response was given permission to name a supplier').toBe(0);
  });

  it('keeps server-side inline exemptions a ceiling too', () => {
    const { exempt } = scanServerCopy();
    expect(exempt, `${EXEMPT_MARKER} markers appeared in server-authored tenant copy`).toBeLessThanOrEqual(MAX_SERVER_EXEMPT_STRINGS);
  });

  it('states which sinks are exempt, and why', () => {
    // Printed rather than asserted, for the same reason the allowlist report
    // is: an exemption nobody can see is an exemption nobody removes.
    for (const { reason } of EXEMPT_SINKS) expect(reason.length, 'an exempt sink carries no reason').toBeGreaterThan(40);
    const { scanned } = scanServerCopy();
    console.log(`[vendor-neutrality] server tenant-facing strings scanned: ${scanned}; sinks exempt: ${EXEMPT_SINKS.length}`);
  });
});
