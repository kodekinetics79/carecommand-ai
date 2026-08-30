import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  REMEDIATION_CODES, isKnownRemediationCode, remediationFor,
} from '../lib/receptionist/remediation';
import { AGENT_READINESS_REASONS } from '../lib/receptionist/agentReadiness';

// ===========================================================================
// Remediation coverage.
//
// The best asset in this module is a written remediation sentence for every
// failure it can report: a title, the action that fixes it, and a link to the
// screen where the fix happens. Two things silently break that promise, and
// both were shipping green:
//
//  1. 33 of 54 `fixTab` ids are not tabs. `deploy` and `agent` are not in the
//     Studio tab union, so `number_bound`, `deployment_current`,
//     `agent_verified`, `prompt_drift` and `verification_failed` all send the
//     owner to the DEFAULT tab at the moment they are stuck (B7).
//  2. Five `ClinicActivationBlocker` codes have no catalogue entry at all, so
//     on the FIRST-RUN path the owner is shown "Something went wrong … report
//     the code" — the exact failure the catalogue exists to prevent (B6).
//
// This file is the standing guard for both. The Studio tab union is read from
// the page's own source rather than restated here, so a tab renamed in the
// browser cannot drift from the links the server sends people to.
// ===========================================================================

const STUDIO_TAB_SOURCE = 'src/lib/receptionistDeployment.ts';
const STUDIO_PAGE = 'src/pages/ReceptionistStudio.tsx';

/**
 * String-literal members of an exported union, read from source. Used for the
 * unions whose modules reach the Fastify/Prisma runtime: this file is a lint
 * over vocabularies, and it should stay runnable without a database.
 */
function unionMembers(file: string, name: string): string[] {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const block = source.match(new RegExp(`export type ${name} =([\\s\\S]*?);\\n`));
  if (!block) throw new Error(`Could not read the ${name} union from ${file}`);
  const codes = [...block[1].matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1]);
  if (!codes.length) throw new Error(`The ${name} union in ${file} parsed to nothing`);
  return codes;
}

const CLINIC_ACTIVATION_BLOCKERS = unionMembers('server/lib/receptionist/activationReadiness.ts', 'ClinicActivationBlocker');

/**
 * The tab ids `isTab()` accepts, read from `ReceptionistStudio.tsx`. Parsing
 * the union is deliberate: a server test cannot import a React page, and a
 * hand-copied list here would be one more place to drift.
 */
function studioTabIds(): string[] {
  // The page used to declare the union inline; it now imports StudioTab from
  // the client library, so parsing the page's `type Tab =` line found a type
  // NAME and silently produced nothing — the guard passed for the wrong reason
  // while it could no longer see anything. Read the ids where they now live,
  // and read the aliases too: a remediation tab that only resolves through an
  // alias is still reachable, and pretending otherwise would fail a working link.
  const source = readFileSync(resolve(process.cwd(), STUDIO_TAB_SOURCE), 'utf8');
  const idsBlock = source.match(/export const STUDIO_TAB_IDS = \[([^\]]+)\]/);
  if (!idsBlock) throw new Error(`Could not read STUDIO_TAB_IDS from ${STUDIO_TAB_SOURCE}`);
  const ids = [...idsBlock[1].matchAll(/'([a-z_-]+)'/g)].map(match => match[1]);
  if (!ids.length) throw new Error(`STUDIO_TAB_IDS in ${STUDIO_TAB_SOURCE} parsed to nothing`);

  const aliasBlock = source.match(/STUDIO_TAB_ALIASES: Record<string, StudioTab> = \{([^}]+)\}/);
  const aliases = aliasBlock ? [...aliasBlock[1].matchAll(/'?([a-z_-]+)'?\s*:/g)].map(match => match[1]) : [];

  // The page renders one button per tab id; a typed-but-unrendered tab is a
  // link that lands nowhere just as surely as an unknown id.
  const page = readFileSync(resolve(process.cwd(), STUDIO_PAGE), 'utf8');
  const listed = [...page.matchAll(/\{ id: '([a-z_-]+)', label:/g)].map(match => match[1]);
  if (listed.length) {
    expect([...listed].sort(), 'every Studio tab id must be rendered as a tab').toEqual([...ids].sort());
  }
  return [...ids, ...aliases];
}

/** Routes outside Studio that a fix link is allowed to point at. */
const NON_STUDIO_ROUTES = new Set(['/scheduling']);

const CONTEXT = {
  clinicId: '11111111-1111-4111-8111-111111111111',
  campaignId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
};

describe('every remediation fix link lands on a screen that exists (B7)', () => {
  it('resolves every fixHref to a tab isTab() accepts (B7)', () => {
    const tabs = new Set(studioTabIds());
    const unreachable: Array<{ code: string; tab: string }> = [];

    for (const code of REMEDIATION_CODES) {
      const remediation = remediationFor(code, CONTEXT);
      if (!remediation.fixTab) {
        expect(remediation.fixHref, `${code} has no tab but produced a link`).toBeNull();
        continue;
      }
      expect(remediation.fixHref, `${code} declares a tab but produced no link`).toBeTruthy();
      const href = remediation.fixHref!;
      if (NON_STUDIO_ROUTES.has(href)) continue;
      const [path, query] = href.split('?');
      expect(path, `${code} points outside Studio`).toBe('/receptionist-studio');
      const tab = new URLSearchParams(query).get('tab');
      if (!tab || !tabs.has(tab)) unreachable.push({ code, tab: tab ?? '<none>' });
    }

    // B7 owns this. 25 entries say `deploy` and 8 say `agent`; the map is
    // `deploy → retell` and `agent → campaign`, or the tabs are renamed per E4
    // — either way the two sides become one vocabulary.
    expect(unreachable, `remediation codes linking to tabs the Studio does not have:\n${
      unreachable.map(row => `  ${row.code} → tab=${row.tab}`).join('\n')}`).toEqual([]);
  });

  it('carries the clinic, campaign and agent through every link so the fix opens the right row', () => {
    for (const code of REMEDIATION_CODES) {
      const remediation = remediationFor(code, CONTEXT);
      if (!remediation.fixHref || NON_STUDIO_ROUTES.has(remediation.fixHref)) continue;
      const params = new URLSearchParams(remediation.fixHref.split('?')[1]);
      expect(params.get('clinic'), `${code} loses the clinic`).toBe(CONTEXT.clinicId);
      expect(params.get('campaign'), `${code} loses the campaign`).toBe(CONTEXT.campaignId);
      expect(params.get('agent'), `${code} loses the agent`).toBe(CONTEXT.agentId);
    }
  });

  it.fails('is called with a context everywhere, so no fix link opens the wrong clinic (B7)', () => {
    // `remediationFor(code)` with no context produces `?tab=…` and nothing
    // else. With two clinics that link opens whichever one the Studio happens
    // to select. Every call site names the row it is about.
    const files = [
      'server/modules/receptionist/campaigns.ts',
      'server/modules/receptionist/deployment.ts',
      'server/modules/receptionist/agents.ts',
      'server/lib/receptionist/agentReverification.ts',
      'server/lib/receptionist/campaignReadiness.ts',
    ];
    const unaddressed: string[] = [];
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      source.split('\n').forEach((line, index) => {
        // One argument only: `remediationFor(x)` / `remediationFor('x')`.
        if (/remediationFor\([^,)]*\)/.test(line)) unaddressed.push(`${file}:${index + 1} ${line.trim()}`);
      });
    }
    expect(unaddressed, `remediationFor called without a RemediationContext:\n${unaddressed.join('\n')}`).toEqual([]);
  });
});

describe('every code a route can emit has remediation copy (B6)', () => {
  it('covers every ClinicActivationBlocker (B6)', () => {
    // `campaigns.ts` throws these AFTER readiness has passed, on the first-run
    // path, which is the worst possible moment to show a bare code.
    const missing = CLINIC_ACTIVATION_BLOCKERS.filter(code => !isKnownRemediationCode(code));
    expect(missing, `ClinicActivationBlocker codes with no catalogue entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('covers every AgentReadinessReason', () => {
    const missing = AGENT_READINESS_REASONS.filter(code => !isKnownRemediationCode(code));
    expect(missing, `agent readiness reasons with no catalogue entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('covers every DeployFailureCode and ReadinessKey declared in the type layer', () => {
    // Both unions are `satisfies`-checked at compile time, but a union member
    // added with `as` or a cast would slip through, and the operator would see
    // the bare code. Read them from the source and assert at runtime.
    for (const name of ['DeployFailureCode', 'ReadinessKey']) {
      const codes = unionMembers('server/lib/receptionist/remediation.ts', name);
      const missing = codes.filter(code => !isKnownRemediationCode(code));
      expect(missing, `${name} members with no catalogue entry: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('never falls back to the unclassified failure for a code the product can emit', () => {
    // The blockers are asserted separately above: they are B6's five missing
    // entries, and listing them here would only report the same gap twice.
    const known = [...REMEDIATION_CODES, ...AGENT_READINESS_REASONS];
    for (const code of known) {
      const remediation = remediationFor(code, CONTEXT);
      expect(remediation.title, `${code} degraded to the unclassified failure`).not.toBe('Something went wrong');
      expect(remediation.action, `${code} has no action`).not.toBe('');
    }
  });

  it('still degrades safely for a code nobody wrote copy for', () => {
    const unknown = remediationFor('a_failure_from_the_future', CONTEXT);
    expect(unknown.title).toBe('Something went wrong');
    expect(unknown.fixHref).toBeNull();
    expect(isKnownRemediationCode('a_failure_from_the_future')).toBe(false);
  });
});

describe('the task that says the receptionist is off the air (D9)', () => {
  it.fails('is filed under a workflow the front desk board can parse', () => {
    // `agentReverification.ts` files `workflow: 'receptionist_deployment'`;
    // `parseReceptionistTask` accepts only `RECEPTIONIST_TASK_WORKFLOW`, and
    // both `/tasks/summary` and the Front Desk lanes filter on that one value.
    // So the single task that means "no caller can reach you" is the single
    // task no lane, badge or banner can show.
    const reverification = readFileSync(resolve(process.cwd(), 'server/lib/receptionist/agentReverification.ts'), 'utf8');
    const contract = readFileSync(resolve(process.cwd(), 'server/lib/receptionist/frontDeskTask.ts'), 'utf8');
    const filed = [...reverification.matchAll(/workflow:\s*'([a-z_]+)'/g)].map(match => match[1]);
    expect(filed, 'agentReverification no longer files a workflow').not.toEqual([]);

    const accepted = contract.match(/export const RECEPTIONIST_TASK_WORKFLOW = '([a-z_]+)'/)?.[1];
    expect(accepted, 'could not read RECEPTIONIST_TASK_WORKFLOW').toBeTruthy();
    const unshowable = [...new Set(filed)].filter(workflow => workflow !== accepted);
    expect(unshowable, `receptionist tasks filed under a workflow the board cannot render: ${unshowable.join(', ')}`).toEqual([]);
  });

  it.fails('uses the priority vocabulary the critical banner reads (D10)', () => {
    // `frontDeskTask.ts` files lowercase `critical`, so receptionist
    // emergencies surface; `agentReverification.ts` files `'HIGH'` and
    // `webhooks.ts` / `outbound.ts` file uppercase. One shared vocabulary, or
    // the banner keeps missing whole classes of task.
    const files = [
      'server/lib/receptionist/frontDeskTask.ts',
      'server/lib/receptionist/agentReverification.ts',
      'server/modules/receptionist/webhooks.ts',
    ];
    const spellings = new Set<string>();
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      for (const match of source.matchAll(/priority:\s*'([A-Za-z_]+)'/g)) spellings.add(match[1]);
    }
    const mixed = [...spellings].filter(value => value !== value.toLowerCase());
    expect(mixed, `priority is filed in more than one vocabulary: ${[...spellings].join(', ')}`).toEqual([]);
  });
});
