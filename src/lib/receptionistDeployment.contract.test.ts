import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { goLiveSteps } from './receptionistDeployment';
import { readinessFixture, serverReadinessKeys } from '../test/fixtures/receptionist/readiness';

// The sources under test, as text. `?raw` rather than `node:fs` so the browser
// project stays free of node globals and `tsc -b` keeps passing.
import campaignReadinessSource from '../../server/lib/receptionist/campaignReadiness.ts?raw';
import activitySource from '../../server/modules/receptionist/activity.ts?raw';
import sharedSource from '../../server/modules/receptionist/shared.ts?raw';
import deploymentClientSource from './receptionistDeployment.ts?raw';
import frontDeskClientSource from './frontDesk.ts?raw';
import bookItDialogSource from '../components/receptionist/BookItDialog.tsx?raw';

// ===========================================================================
// The browser's assumptions, checked against the server's own source.
//
// Every defect in this file has the same shape: the client names a thing the
// server does not send, both sides have their own passing tests, and the
// product is broken in the gap between them.
//
//   E2 — the Go-live card reads `phone_number_bound`; the server emits
//        `number_bound`. "Forward the public number to the DID" is therefore
//        permanently "Not evaluated yet.", gets no Fix link, and the card can
//        never reach 5/5. That step IS the live incident where nobody could
//        reach the advertised line, and both jsdom fixtures encoded the wrong
//        key, so it shipped green.
//
//   E1 — "Book it" for a caller with no patient record sends
//        `patientId: { create: … }`; the route's `.strict()` schema wants
//        `createPatient`. Every unknown-caller booking 400s, which is the
//        primary inbound loop of the whole product.
//
// So this file reads the SERVER'S source — the readiness labels, and the Zod
// schema of the book route, evaluated from the text of the route itself — and
// checks the browser against it. Nothing here restates a contract by hand;
// restating is how the two sides drifted in the first place.
// ===========================================================================

/** String-literal members of a `type X = 'a' | 'b'` union. */
function unionMembers(source: string, name: string): string[] {
  const block = source.match(new RegExp(`export type ${name} =([\\s\\S]*?);\\n`));
  if (!block) throw new Error(`Could not read the ${name} union`);
  const members = [...block[1].matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1]);
  if (!members.length) throw new Error(`The ${name} union parsed to nothing`);
  return members;
}

// ---------------------------------------------------------------------------
// Readiness keys
// ---------------------------------------------------------------------------

describe('the readiness vocabulary is one vocabulary (E2)', () => {
  it.fails('client ReadinessKey equals the keys the server emits', () => {
    const server = serverReadinessKeys().sort();
    const client = unionMembers(deploymentClientSource, 'ReadinessKey').sort();
    // E2 owns this: rename `phone_number_bound` → `number_bound` and delete the
    // client-only `locale_pack_approved` / `hours_set` / `offer_content`, which
    // no server evaluation produces.
    expect(client, [
      'The browser reads readiness keys the server does not emit.',
      `  only in the client: ${client.filter(key => !server.includes(key)).join(', ') || '—'}`,
      `  only on the server: ${server.filter(key => !client.includes(key)).join(', ') || '—'}`,
    ].join('\n')).toEqual(server);
  });

  it('client and server agree on the four readiness statuses', () => {
    const server = unionMembers(campaignReadinessSource, 'ReadinessStatus').sort();
    const client = unionMembers(deploymentClientSource, 'ReadinessStatus').sort();
    expect(client).toEqual(server);
  });
});

describe('the Go-live card reads rows the server actually sends (E2)', () => {
  it('shows every step as done when the server reports every check passing', () => {
    const steps = goLiveSteps(readinessFixture(), 'DRAFT');
    const unevaluated = steps.filter(step => step.status === 'pending');
    // "Forward the public number to the DID" is the step the live audit found
    // broken — nobody could reach the advertised number. It must not be able to
    // read a key that does not exist.
    expect(unevaluated.map(step => `${step.key}: ${step.detail}`), 'E2: a Go-live step reads a key the server never emits').toEqual([]);
  });

  it('never claims a step is done when the server has not evaluated it', () => {
    const steps = goLiveSteps(null, 'DRAFT');
    for (const step of steps.filter(step => step.key !== 'activate')) {
      expect(step.status, `${step.key} without a readiness response`).toBe('pending');
      expect(step.detail).toBe('Not evaluated yet.');
    }
  });
});

// ---------------------------------------------------------------------------
// The book route's request body
// ---------------------------------------------------------------------------

/** Index just past the parenthesis opened at `open`. */
function closingParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('Unbalanced parentheses while reading the book route schema');
}

/**
 * Pull one `export const NAME = <expr>;` out of a server module by scanning to
 * the terminating semicolon at bracket depth zero.
 */
function exportedExpression(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = `);
  if (start === -1) throw new Error(`Could not find "export const ${name}"`);
  let index = start + `export const ${name} = `.length;
  let depth = 0;
  const from = index;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ';' && depth === 0) break;
  }
  return source.slice(from, index);
}

/**
 * The Zod schema `POST /appointment-requests/:id/book` parses its body with,
 * evaluated from the route's own source. Not a copy: a copy is exactly the
 * artefact that let the client and the server disagree for a whole release.
 */
function serverBookSchema(): { schema: z.ZodTypeAny; fields: string[] } {
  const shared = sharedSource;
  const activity = activitySource;

  const route = activity.indexOf("app.post('/appointment-requests/:id/book'");
  expect(route, 'the book route moved or was renamed').toBeGreaterThan(-1);
  const schemaStart = activity.indexOf('z.object({', route);
  const schemaEnd = activity.indexOf('.parse(request.body)', schemaStart);
  expect(schemaStart, 'no z.object in the book route').toBeGreaterThan(-1);
  expect(schemaEnd, 'the book route no longer parses request.body').toBeGreaterThan(schemaStart);
  // The OUTER `z.object(...)`, found by matching its own parenthesis —
  // `createPatient` is a nested strict object, so a search for `.strict()`
  // would stop inside it.
  const objectEnd = closingParen(activity, schemaStart + 'z.object'.length);
  expect(activity.slice(objectEnd, objectEnd + 9), 'the book route body schema is no longer strict').toBe('.strict()');

  const preamble = `
    const uuid = ${exportedExpression(shared, 'uuid')};
    const e164Phone = ${exportedExpression(shared, 'e164Phone')};
    const optionalE164Phone = ${exportedExpression(shared, 'optionalE164Phone')};
  `;
  const build = new Function('z', `${preamble}
    return {
      schema: ${activity.slice(schemaStart, schemaEnd)},
      object: ${activity.slice(schemaStart, objectEnd)},
    };
  `) as (zod: typeof z) => { schema: z.ZodTypeAny; object: z.ZodObject<z.ZodRawShape> };
  const built = build(z);
  const fields = Object.keys(built.object.shape);
  expect(fields.length, 'the book body schema parsed to no fields').toBeGreaterThan(0);
  return { schema: built.schema, fields };
}

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('the body the browser sends is the body the route accepts (E1)', () => {
  it('evaluates the real server schema, so this file can never drift from it', () => {
    const { schema } = serverBookSchema();
    const accepted = schema.safeParse({
      createPatient: { firstName: 'Alex', lastName: 'Morgan', phone: '+14155550142' },
      providerProfileId: VALID_UUID,
      startsAt: '2026-09-03T15:00:00.000Z',
      service: 'New patient consultation',
      acknowledgeRequestDifferences: true,
    });
    expect(accepted.success, JSON.stringify(accepted.error?.issues ?? [])).toBe(true);

    // Strict, and one of the two patient forms — never both, never neither.
    expect(schema.safeParse({
      patientId: VALID_UUID,
      createPatient: { firstName: 'Alex', lastName: 'Morgan' },
      providerProfileId: VALID_UUID,
      startsAt: '2026-09-03T15:00:00.000Z',
      service: 'X',
      acknowledgeRequestDifferences: true,
    }).success).toBe(false);
    expect(schema.safeParse({
      providerProfileId: VALID_UUID,
      startsAt: '2026-09-03T15:00:00.000Z',
      service: 'X',
      acknowledgeRequestDifferences: true,
    }).success).toBe(false);
  });

  it('rejects the nested-create shape, with the message staff were actually shown', () => {
    const { schema } = serverBookSchema();
    const rejected = schema.safeParse({
      patientId: { create: { firstName: 'Alex', lastName: 'Morgan', branchId: VALID_UUID } },
      providerProfileId: VALID_UUID,
      startsAt: '2026-09-03T15:00:00.000Z',
      service: 'New patient consultation',
      acknowledgeRequestDifferences: true,
    });
    expect(rejected.success).toBe(false);
    expect(JSON.stringify(rejected.error?.issues)).toContain('patientId');
  });

  it('BookItDialog emits createPatient, not a nested patientId create', () => {
    const dialog = bookItDialogSource;
    const body = dialog.slice(dialog.indexOf('const body: BookRequestBody'), dialog.indexOf('const result = await booking.run'));
    expect(body.length, 'the submit body moved').toBeGreaterThan(0);
    // E1 owns this. The route wants `{ createPatient: { firstName, lastName,
    // phone } }`; `phone` matters because a new patient with no number cannot
    // be sent a confirmation or called back, which is what the dialog already
    // promises the staff member.
    expect(
      /createPatient\s*:/.test(body) && !/patientId\s*:\s*[^,\n]*\{\s*create/.test(body),
      `E1: the dialog still sends the shape the route refuses:\n${body.trim()}`,
    ).toBe(true);
  });

  it('BookRequestBody declares only fields the route accepts', () => {
    const { fields: serverKeys } = serverBookSchema();
    const client = frontDeskClientSource;
    const block = client.match(/export interface BookRequestBody \{([\s\S]*?)\n\}/);
    expect(block, 'BookRequestBody moved out of src/lib/frontDesk.ts').toBeTruthy();
    const clientFields = [...block![1].matchAll(/^\s{2}([A-Za-z]+)\??:/gm)].map(match => match[1]);
    expect(clientFields.length).toBeGreaterThan(0);

    const unknownToServer = clientFields.filter(field => !serverKeys.includes(field));
    expect(unknownToServer, `client fields the strict route would reject: ${unknownToServer.join(', ')}`).toEqual([]);
    expect(clientFields, 'E1: the client type has no way to express the create-a-patient branch').toContain('createPatient');
  });
});
