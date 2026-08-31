# The reminder product: what "finished" means

Written **before** the three implementation branches land, deliberately, so the
bar is not quietly redefined to match whatever was built. This is the same
method that fixed outbound calling: PR #33 wrote nine failing tests describing
the defect, and the fix was not accepted until they passed with no assertion
weakened.

The owner's instruction was: *"I don't want half baked product demo."*
This document is what stops that happening.

---

## The journey, end to end

A clinic has appointments next week. It wants each patient rung, told their own
appointment, and asked to confirm or cancel — and it wants to open the app
afterwards and see who confirmed.

Every step below must work **with no engineer involved**.

| # | Step | Done when |
|---|------|-----------|
| 1 | Build a reminder campaign from real appointments | Targets are created bound to a specific `Appointment`, with every existing fence intact (identity binding, consent, DNC, purpose/legal basis/policy) |
| 2 | The call is about *that patient's* appointment | The provider request carries the real clinician, date, time, service and location, in the **branch's** timezone. An unbound target sends empty strings — never "your appointment" |
| 3 | The patient confirms | `Appointment.patientConfirmedAt` is set, `patientConfirmationSource = 'receptionist_call'`, and `patientConfirmedCallLogId` names the call that proves it |
| 4 | The patient cancels | The appointment moves to `CANCELED` on the existing signed path. Unchanged by this work |
| 5 | The clinic sees the result | Confirmed appointments are visibly confirmed **by the patient**, distinct from `status: CONFIRMED` which only ever meant "the clinic booked this" |
| 6 | The list is worked automatically | A dialler walks PENDING targets without a human clicking Call per patient |

---

## What must remain true (the part a demo hides)

These are not features. They are the reasons this is allowed near a patient's
phone at all, and a build that ships without them is not "mostly done".

1. **Every fence that guards a manual call guards an automated one**, and none of
   them is reimplemented. Duplicated safety logic is worse than no dialler,
   because the copies drift and nobody knows which one is authoritative.
2. **Consent and DNC are re-checked at dial time**, not at enqueue time. A
   patient who opts out after a queue is filled must not be rung.
3. **Quiet hours are evaluated in the branch's timezone**, never the server's.
4. **The kill switch stops calling immediately**, mid-run.
5. **Confirmation never becomes `AppointmentStatus`.** `CONFIRMED` is the default
   a row is created with. Collapsing the two destroys the only distinction a
   reminder campaign exists to produce.
6. **Whoever answers a phone is not proven to be the patient.** Identity
   verification is not relaxed because we placed the call.
7. **No panel prints a number it did not receive.** A failed load is an error,
   never a zero.

---

## How it gets checked

- The three branches are merged into one integration branch and tested
  **together**, not separately. Tonight's outbound fix passed in isolation and
  the interaction is where the defects were.
- A journey test drives steps 1–6 against the simulated provider and asserts
  **database outcomes**, not internal function calls, so it survives refactoring.
- `npm run verify:prisma-drift`, `api:typecheck`, and `lint` run bare.
- **An attended live call to an authorized number is the last gate.** Everything
  above runs against a simulator, and a simulator that answers with whatever we
  expect is exactly how ~2,400 green tests once described a provider that could
  not fail.

## Not in scope, and honest about it

- Reschedule-by-voice on a reminder call (the tool exists for inbound; the
  reminder flow does not use it yet).
- Multi-language reminder wording beyond the en-US and en-GB packs.
- Any automatic retry policy beyond the campaign's existing `maxRetryAttempts`.

If a demo is given before the six steps pass together, say which of them does
not work rather than choosing a path that avoids it.
