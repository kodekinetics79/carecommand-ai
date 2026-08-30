import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarPlus, Loader2, X } from 'lucide-react';
import { Field, Select, TextInput } from '../ui/Field';
import {
  frontDeskApi,
  type AppointmentRequestRow, type BookRequestBody, type BookRequestResult, type BookableProvider,
  type PatientMatch, type ProviderSlot, type ServiceCatalogRow,
} from '../../lib/frontDesk';
import { formatClinicDateTime, formatClinicTime } from '../../lib/frontDeskTime';
import { todayInZone } from '../../lib/clinicTime';
import { describeFailure, type ResourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { notifyFrontDeskMutated } from '../../hooks/useFrontDeskPoll';
import { MutationNotice } from './MutationNotice';

type LoadState<T> = { status: 'idle' | 'loading' } | { status: 'ready'; data: T } | { status: 'error'; failure: ResourceFailure };

/** A provider with no active availability window has no slots to offer, ever. */
function hasAvailability(provider: BookableProvider): boolean {
  // Absent `_count` means the server did not tell us, and "unknown" must not be
  // rendered as "none" — the provider stays selectable.
  return provider._count?.availability === undefined || provider._count.availability > 0;
}

/**
 * "Book it" for a core appointment request (design-C4 §3.3 / §4.2).
 *
 * One dialog: patient (linked, found, or created) → service → provider →
 * date → a REAL open slot from the scheduler → confirm. It posts to
 * `POST /appointment-requests/:id/book`, which books through the atomic
 * scheduler, links the request and completes the receptionist task in one
 * transaction. A 409 `slot_unavailable` keeps the dialog open with the
 * server's reason; the request stays pending until an Appointment exists.
 *
 * What changed on day 2 (E1, E15):
 *   - the create-a-patient branch emitted `patientId: { create: … }` against a
 *     `.strict()` schema that wants a sibling `createPatient`, so booking an
 *     unknown caller — the primary inbound loop — always 400'd;
 *   - the dialog claimed `aria-modal` without trapping Tab, so a keyboard user
 *     landed on Reject in the lane behind it;
 *   - it promised the server would link the caller's phone. Nothing did, so a
 *     new patient had no number and no confirmation could be delivered;
 *   - it listed providers with no availability at all, and staff cycled dates
 *     forever against "No open slot on this day".
 */
export function BookItDialog({ request, timezone, onClose, onBooked }: {
  request: AppointmentRequestRow;
  timezone: string;
  onClose: () => void;
  onBooked: (result: BookRequestResult) => void | Promise<void>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const booking = useMutationState();
  const busy = isBusy(booking.state);

  const [providers, setProviders] = useState<LoadState<BookableProvider[]>>({ status: 'loading' });
  const [services, setServices] = useState<LoadState<ServiceCatalogRow[]>>({ status: 'loading' });
  const [providerId, setProviderId] = useState('');
  const [service, setService] = useState(request.requestedService ?? '');
  const [date, setDate] = useState(() => todayInZone(timezone, request.requestedDateTime ? new Date(request.requestedDateTime) : new Date()));
  const [slots, setSlots] = useState<LoadState<ProviderSlot[]>>({ status: 'idle' });
  const [startsAt, setStartsAt] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const [patientMode, setPatientMode] = useState<'linked' | 'search' | 'create'>(request.patientId ? 'linked' : 'create');
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<LoadState<PatientMatch[]>>({ status: 'idle' });
  const [selectedPatientId, setSelectedPatientId] = useState<string>(request.patientId ?? '');
  const [firstName, setFirstName] = useState(() => (request.collectedName ?? '').trim().split(/\s+/)[0] ?? '');
  const [lastName, setLastName] = useState(() => (request.collectedName ?? '').trim().split(/\s+/).slice(1).join(' '));
  const [phone, setPhone] = useState('');
  const [revealing, setRevealing] = useState(false);
  const [phoneNotice, setPhoneNotice] = useState<string | null>(null);

  useFocusTrap(dialogRef, { onClose });

  useEffect(() => {
    let active = true;
    void (async () => {
      setProviders({ status: 'loading' });
      try {
        const rows = await frontDeskApi.listProviders();
        if (active) setProviders({ status: 'ready', data: rows.filter(row => row.active) });
      } catch (error) {
        if (active) setProviders({ status: 'error', failure: describeFailure(error) });
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      setServices({ status: 'loading' });
      try {
        const rows = await frontDeskApi.listServices();
        if (active) setServices({ status: 'ready', data: rows.filter(row => row.active) });
      } catch (error) {
        if (active) setServices({ status: 'error', failure: describeFailure(error) });
      }
    })();
    return () => { active = false; };
  }, []);

  const provider = useMemo(() => providers.status === 'ready' ? providers.data.find(row => row.id === providerId) ?? null : null, [providers, providerId]);

  // The catalog the voice agent can actually book, first; everything else stays
  // available because a human at the desk may book what the agent may not.
  const voiceBookable = services.status === 'ready' ? services.data.filter(row => row.bookableByVoice) : [];
  const otherServices = services.status === 'ready' ? services.data.filter(row => !row.bookableByVoice) : [];
  const requestedServiceInCatalog = services.status !== 'ready' || !request.requestedService
    ? true
    : services.data.some(row => row.name.trim().toLocaleLowerCase() === request.requestedService!.trim().toLocaleLowerCase());

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!providerId || !date || !service.trim()) { setSlots({ status: 'idle' }); setStartsAt(''); return; }
      setSlots({ status: 'loading' });
      setStartsAt('');
      try {
        const response = await frontDeskApi.providerSlots(providerId, date, service.trim());
        if (!active) return;
        setSlots({ status: 'ready', data: response.slots });
        // Default to the first slot at or after the requested time, else the first slot.
        const requested = request.requestedDateTime ? new Date(request.requestedDateTime).getTime() : 0;
        const preferred = response.slots.find(slot => new Date(slot.startsAt).getTime() >= requested) ?? response.slots[0];
        if (preferred) setStartsAt(preferred.startsAt);
      } catch (error) {
        if (active) setSlots({ status: 'error', failure: describeFailure(error) });
      }
    })();
    return () => { active = false; };
  }, [providerId, date, service, request.requestedDateTime]);

  async function runSearch() {
    const term = search.trim();
    if (term.length < 2) return;
    setMatches({ status: 'loading' });
    try {
      setMatches({ status: 'ready', data: await frontDeskApi.searchPatients(term) });
    } catch (error) {
      setMatches({ status: 'error', failure: describeFailure(error) });
    }
  }

  /**
   * The caller's number reaches the list masked. The unmasked value lives on
   * the audited detail route, so taking it is an explicit act with a log entry
   * behind it — the same rule the task card's "Call back" follows.
   */
  async function revealCallerPhone() {
    setRevealing(true);
    setPhoneNotice(null);
    try {
      const detail = await frontDeskApi.getAppointmentRequest(request.id);
      const number = detail.collectedPhone?.trim() || null;
      if (!number) { setPhoneNotice('No caller number is stored on this request. Type one if the caller gave it another way.'); return; }
      setPhone(number);
      setPhoneNotice('Taken from the call. The reveal was logged.');
    } catch (error) {
      setPhoneNotice(`The caller's number could not be read: ${describeFailure(error).message}`);
    } finally {
      setRevealing(false);
    }
  }

  const phoneTrimmed = phone.trim();
  const phoneValid = phoneTrimmed === '' || /^\+[1-9]\d{7,14}$/.test(phoneTrimmed);
  const patientReady = patientMode === 'create'
    ? firstName.trim().length > 0 && lastName.trim().length > 0 && phoneValid
    : selectedPatientId.length > 0;
  const canSubmit = !busy && patientReady && Boolean(providerId) && Boolean(startsAt) && service.trim().length > 0 && acknowledged;

  /** Why Confirm is unavailable, in the order a person fills the form. */
  const blockedBecause = busy ? null
    : !patientReady ? (patientMode === 'create'
      ? (!phoneValid ? 'A phone number must be in +country format, or left blank.' : 'Give the new patient a first and last name.')
      : 'Choose the patient this booking is for.')
      : !service.trim() ? 'Choose the service being booked.'
        : !providerId ? 'Choose a provider.'
          : !startsAt ? 'Choose an open slot.'
            : !acknowledged ? 'Confirm you compared this booking with what the caller asked for.'
              : null;

  async function submit() {
    if (!canSubmit || !provider) return;
    const body: BookRequestBody = {
      // E1: `createPatient` is a SIBLING of `patientId` and the route's schema
      // is strict — `branchId` is not one of its fields, the branch comes from
      // the provider.
      ...(patientMode === 'create'
        ? {
          createPatient: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            ...(phoneTrimmed ? { phone: phoneTrimmed } : {}),
          },
        }
        : { patientId: selectedPatientId }),
      providerProfileId: providerId,
      startsAt,
      service: service.trim(),
      acknowledgeRequestDifferences: true,
    };
    const result = await booking.run(() => frontDeskApi.bookAppointmentRequest(request.id, body), { successMessage: 'Booked' });
    if (result) { notifyFrontDeskMutated(); await onBooked(result); }
  }

  const requestedLabel = request.requestedDateTime ? formatClinicDateTime(request.requestedDateTime, timezone) : 'no preferred time';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="w-full max-w-lg rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-5 shadow-xl space-y-4 outline-none max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-base font-bold text-t1 inline-flex items-center gap-2"><CalendarPlus className="h-4 w-4 text-indigo" aria-hidden="true" /> Book it</h2>
            <p className="text-xs text-t3 mt-0.5">
              {request.collectedName ?? request.callLog?.callerName ?? 'Unknown caller'} asked for {request.requestedService ?? 'an appointment'} · {requestedLabel}
              {request.missingFields.length > 0 && <span className="block text-amber-v">Missing from the call: {request.missingFields.join(', ')}</span>}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-t3 hover:bg-[var(--s3)]"><X className="h-4 w-4" /></button>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[11px] font-bold uppercase tracking-wide text-t3">Patient</legend>
          {request.patientId && (
            <label className="flex items-center gap-2 text-xs text-t2">
              <input type="radio" name="patient-mode" checked={patientMode === 'linked'} onChange={() => { setPatientMode('linked'); setSelectedPatientId(request.patientId ?? ''); }} />
              Linked patient{request.patient ? `: ${request.patient.firstName} ${request.patient.lastName}` : ''}
            </label>
          )}
          <label className="flex items-center gap-2 text-xs text-t2">
            <input type="radio" name="patient-mode" checked={patientMode === 'search'} onChange={() => { setPatientMode('search'); setSelectedPatientId(''); }} />
            Find an existing patient
          </label>
          {patientMode === 'search' && (
            <div className="space-y-2 pl-5">
              <div className="flex gap-2">
                <TextInput value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, email or phone" aria-label="Search patients"
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void runSearch(); } }} />
                <button type="button" onClick={() => void runSearch()} className="shrink-0 rounded-lg border border-[var(--b1)] px-3 text-xs font-semibold text-t2">Search</button>
              </div>
              {matches.status === 'loading' && <p className="text-[11px] text-t3"><Loader2 className="inline h-3 w-3 animate-spin" /> Searching…</p>}
              {matches.status === 'error' && <p role="alert" className="text-[11px] text-red-v">{matches.failure.message}</p>}
              {matches.status === 'ready' && matches.data.length === 0 && <p className="text-[11px] text-t3">No patient matched.</p>}
              {matches.status === 'ready' && matches.data.map(match => (
                <label key={match.id} className="flex items-center gap-2 text-xs text-t2">
                  <input type="radio" name="patient-match" checked={selectedPatientId === match.id} onChange={() => setSelectedPatientId(match.id)} />
                  {match.firstName} {match.lastName}
                </label>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-t2">
            <input type="radio" name="patient-mode" checked={patientMode === 'create'} onChange={() => { setPatientMode('create'); setSelectedPatientId(''); }} />
            Create a new patient record
          </label>
          {patientMode === 'create' && (
            <div className="grid grid-cols-2 gap-2 pl-5">
              <Field label="First name" required><TextInput value={firstName} onChange={event => setFirstName(event.target.value)} maxLength={80} /></Field>
              <Field label="Last name" required><TextInput value={lastName} onChange={event => setLastName(event.target.value)} maxLength={80} /></Field>
              <div className="col-span-2 space-y-1">
                <Field label="Phone" hint="E.164, e.g. +14155550142. Without it the new patient gets no confirmation and nobody can call them back.">
                  <TextInput value={phone} onChange={event => { setPhone(event.target.value); setPhoneNotice(null); }} maxLength={20} inputMode="tel" aria-label="Phone" />
                </Field>
                {request.collectedPhoneMasked && (
                  <button type="button" disabled={revealing} onClick={() => void revealCallerPhone()}
                    className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
                    {revealing ? 'Reading…' : `Use the caller's number ${request.collectedPhoneMasked} (revealed and logged)`}
                  </button>
                )}
                {!request.collectedPhoneMasked && <p className="text-[10px] text-t3">The call recorded no phone number for this caller.</p>}
                {phoneNotice && <p role="status" className="text-[10px] font-semibold text-amber-v">{phoneNotice}</p>}
                {!phoneValid && <p role="alert" className="text-[10px] font-semibold text-red-v">A phone number must be E.164 (+ country code, digits only).</p>}
              </div>
            </div>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Service" required hint="From the tenant's service catalog. Bookable-by-voice services are listed first.">
            {services.status === 'error' ? (
              <>
                <p role="alert" className="text-[11px] text-red-v">The service catalog could not be loaded ({services.failure.message}), so the name is typed instead of chosen.</p>
                <TextInput value={service} onChange={event => setService(event.target.value)} maxLength={160} aria-label="Service" />
              </>
            ) : (
              <Select value={service} onChange={event => setService(event.target.value)} disabled={services.status !== 'ready'} aria-label="Service">
                <option value="">{services.status === 'loading' ? 'Loading services…' : 'Choose a service'}</option>
                {!requestedServiceInCatalog && request.requestedService && (
                  <option value={request.requestedService}>{request.requestedService} (asked for on the call — not in the catalog)</option>
                )}
                {voiceBookable.length > 0 && (
                  <optgroup label="Bookable by voice">
                    {voiceBookable.map(row => <option key={row.id} value={row.name}>{row.name}</option>)}
                  </optgroup>
                )}
                {otherServices.length > 0 && (
                  <optgroup label="Desk only (the AI cannot book these)">
                    {otherServices.map(row => <option key={row.id} value={row.name}>{row.name}</option>)}
                  </optgroup>
                )}
              </Select>
            )}
          </Field>
          <Field label="Provider" required>
            {providers.status === 'error' ? (
              <p role="alert" className="text-[11px] text-red-v">Providers could not be loaded. {providers.failure.message}</p>
            ) : (
              <>
                <Select value={providerId} onChange={event => setProviderId(event.target.value)} disabled={providers.status !== 'ready'} aria-label="Provider">
                  <option value="">{providers.status === 'loading' ? 'Loading providers…' : 'Choose a provider'}</option>
                  {providers.status === 'ready' && providers.data.map(row => (
                    <option key={row.id} value={row.id} disabled={!hasAvailability(row)}>
                      {row.user.displayName} · {row.branch.name}{hasAvailability(row) ? '' : ' — no working hours set'}
                    </option>
                  ))}
                </Select>
                {providers.status === 'ready' && providers.data.some(row => !hasAvailability(row)) && (
                  <p className="text-[10px] text-t3">
                    A provider with no working hours can never have an open slot.{' '}
                    <a href="/scheduling" className="font-semibold text-indigo hover:underline">Set availability in Scheduling</a>.
                  </p>
                )}
                {providers.status === 'ready' && providers.data.length > 0 && providers.data.every(row => !hasAvailability(row)) && (
                  <p role="alert" className="text-[10px] font-semibold text-amber-v">
                    No provider has availability, so nothing can be booked from here yet.
                  </p>
                )}
              </>
            )}
          </Field>
          <Field label="Date" required hint={`Clinic time (${timezone})`}>
            <TextInput type="date" value={date} onChange={event => setDate(event.target.value)} aria-label="Date" />
          </Field>
          <Field label="Open slot" required>
            {slots.status === 'idle' && <p className="text-[11px] text-t3">Choose a provider, service and date to see open slots.</p>}
            {slots.status === 'loading' && <p className="text-[11px] text-t3"><Loader2 className="inline h-3 w-3 animate-spin" /> Checking availability…</p>}
            {slots.status === 'error' && <p role="alert" className="text-[11px] text-red-v">Slots could not be loaded. {slots.failure.message}</p>}
            {slots.status === 'ready' && slots.data.length === 0 && (
              <p className="text-[11px] text-amber-v">
                {provider && !hasAvailability(provider)
                  ? 'This provider has no working hours set, so no date will show a slot.'
                  : 'No open slot on this day. Pick another date.'}
              </p>
            )}
            {slots.status === 'ready' && slots.data.length > 0 && (
              <Select value={startsAt} onChange={event => setStartsAt(event.target.value)} aria-label="Open slot">
                {slots.data.map(slot => <option key={slot.startsAt} value={slot.startsAt}>{formatClinicTime(slot.startsAt, timezone)}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <label className="flex items-start gap-2 text-xs text-t2">
          <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-0.5" />
          <span>I compared the selected patient, service and slot with what the caller asked for; any difference is intentional.</span>
        </label>

        <MutationNotice state={booking.state} showSaved={false} />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {blockedBecause && <p className="mr-auto text-[10px] text-t3">{blockedBecause}</p>}
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Cancel</button>
          <button type="button" disabled={!canSubmit} onClick={() => void submit()} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />} Confirm booking
          </button>
        </div>
      </div>
    </div>
  );
}
