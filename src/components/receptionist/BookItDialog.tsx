import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarPlus, Loader2, X } from 'lucide-react';
import { Field, Select, TextInput } from '../ui/Field';
import {
  frontDeskApi, type AppointmentRequestRow, type BookRequestBody, type BookRequestResult, type BookableProvider, type PatientMatch, type ProviderSlot,
} from '../../lib/frontDesk';
import { formatClinicDateTime, formatClinicTime } from '../../lib/frontDeskTime';
import { todayInZone } from '../../lib/clinicTime';
import { describeFailure, type ResourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { notifyFrontDeskMutated } from '../../hooks/useFrontDeskPoll';
import { MutationNotice } from './MutationNotice';

type LoadState<T> = { status: 'idle' | 'loading' } | { status: 'ready'; data: T } | { status: 'error'; failure: ResourceFailure };

/**
 * "Book it" for a core appointment request (design-C4 §3.3 / §4.2).
 *
 * One dialog: patient (linked, found, or created) → service → provider →
 * date → a REAL open slot from the scheduler → confirm. It posts to
 * `POST /appointment-requests/:id/book`, which books through the atomic
 * scheduler, links the request and completes the receptionist task in one
 * transaction. A 409 `slot_unavailable` keeps the dialog open with the
 * server's reason; the request stays pending until an Appointment exists.
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

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previouslyFocused?.focus(); };
  }, [onClose]);

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

  const provider = useMemo(() => providers.status === 'ready' ? providers.data.find(row => row.id === providerId) ?? null : null, [providers, providerId]);

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

  const patientReady = patientMode === 'create'
    ? firstName.trim().length > 0 && lastName.trim().length > 0 && Boolean(provider)
    : selectedPatientId.length > 0;
  const canSubmit = !busy && patientReady && Boolean(providerId) && Boolean(startsAt) && service.trim().length > 0 && acknowledged;

  async function submit() {
    if (!canSubmit || !provider) return;
    const body: BookRequestBody = {
      patientId: patientMode === 'create'
        ? { create: { firstName: firstName.trim(), lastName: lastName.trim(), branchId: request.branchId ?? provider.branchId } }
        : selectedPatientId,
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
              <p className="col-span-2 text-[10px] text-t3">The collected phone stays on the request and is linked by the server; it is not retyped here.</p>
            </div>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Service" required hint="Must match an active catalog service.">
            <TextInput value={service} onChange={event => setService(event.target.value)} maxLength={160} />
          </Field>
          <Field label="Provider" required>
            {providers.status === 'error' ? (
              <p role="alert" className="text-[11px] text-red-v">Providers could not be loaded. {providers.failure.message}</p>
            ) : (
              <Select value={providerId} onChange={event => setProviderId(event.target.value)} disabled={providers.status !== 'ready'} aria-label="Provider">
                <option value="">{providers.status === 'loading' ? 'Loading providers…' : 'Choose a provider'}</option>
                {providers.status === 'ready' && providers.data.map(row => (
                  <option key={row.id} value={row.id}>{row.user.displayName} · {row.branch.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Date" required hint={`Clinic time (${timezone})`}>
            <TextInput type="date" value={date} onChange={event => setDate(event.target.value)} aria-label="Date" />
          </Field>
          <Field label="Open slot" required>
            {slots.status === 'idle' && <p className="text-[11px] text-t3">Choose a provider, service and date to see open slots.</p>}
            {slots.status === 'loading' && <p className="text-[11px] text-t3"><Loader2 className="inline h-3 w-3 animate-spin" /> Checking availability…</p>}
            {slots.status === 'error' && <p role="alert" className="text-[11px] text-red-v">Slots could not be loaded. {slots.failure.message}</p>}
            {slots.status === 'ready' && slots.data.length === 0 && <p className="text-[11px] text-amber-v">No open slot on this day. Pick another date.</p>}
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

        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Cancel</button>
          <button type="button" disabled={!canSubmit} onClick={() => void submit()} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />} Confirm booking
          </button>
        </div>
      </div>
    </div>
  );
}
