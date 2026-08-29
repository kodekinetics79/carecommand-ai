import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarClock, CalendarOff, Plus, Trash2, UserPlus, X } from 'lucide-react';
import BentoCard from '../ui/BentoCard';
import { ResourceErrorNotice, ResourceSkeleton } from '../ui/ResourceSection';
import { describeFailure } from '../../lib/resourceState';
import { hasPermission } from '../../lib/access';
import { schedulingApi, type AvailabilityWindow, type TimeOffEntry } from '../../lib/appointments';
import { providersApi, type ProviderCandidate } from '../../lib/providers';
import type { SessionUser } from '../../lib/session';
import type { Doctor } from '../../types';

// ===========================================================================
// Provider setup — the missing half of scheduling.
//
// Every booking path in this product resolves a ProviderProfile and then that
// provider's recurring availability. Both routes existed and worked; nothing in
// the app called either, so a clinic with no provider row had a "Book
// appointment" button that could never be completed and no way to fix it.
//
// This panel is that way. It only offers what the caller's grants allow —
// onboarding/retiring a clinician is `admin:manage`, working hours and time off
// are `schedule:manage` — because an offered control that answers 403 is the
// same lie as a button that does nothing.
// ===========================================================================

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SLOT_CHOICES = [10, 15, 20, 30, 45, 60, 90];

const pad = (value: number) => String(value).padStart(2, '0');
const minutesToTime = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || hour * 60 + minute > 1440) return null;
  return hour * 60 + minute;
}

interface EditorRow { key: string; dayOfWeek: number; start: string; end: string; slotMinutes: number }
let rowSeq = 0;
const newRow = (dayOfWeek: number): EditorRow => ({ key: `row-${rowSeq++}`, dayOfWeek, start: '09:00', end: '17:00', slotMinutes: 30 });

/**
 * Local mirror of the server's rules, so the form says what is wrong before it
 * asks. The server re-checks all of it; this only saves a round trip.
 */
function parseRows(rows: EditorRow[]): { error: string } | { windows: AvailabilityWindow[] } {
  const windows: AvailabilityWindow[] = [];
  for (const row of rows) {
    const startMinute = timeToMinutes(row.start);
    const endMinute = timeToMinutes(row.end);
    const day = DAY_LABELS[row.dayOfWeek];
    if (startMinute === null || endMinute === null) return { error: `Enter a start and end time for ${day}.` };
    if (endMinute <= startMinute) return { error: `${day} ends before it starts.` };
    if (endMinute - startMinute < row.slotMinutes) return { error: `${day} is shorter than one ${row.slotMinutes}-minute appointment.` };
    if (windows.some(other => other.dayOfWeek === row.dayOfWeek && startMinute < other.endMinute && other.startMinute < endMinute)) {
      return { error: `Two ${day} windows overlap. Merge them into one.` };
    }
    windows.push({ dayOfWeek: row.dayOfWeek, startMinute, endMinute, slotMinutes: row.slotMinutes });
  }
  return { windows };
}

function summariseWindows(windows: AvailabilityWindow[]): string {
  if (windows.length === 0) return 'No working hours set';
  return [...windows]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute)
    .map(w => `${DAY_SHORT[w.dayOfWeek]} ${minutesToTime(w.startMinute)}–${minutesToTime(w.endMinute)}`)
    .join(' · ');
}

/** datetime-local value -> ISO, treating the entry as the browser's local time. */
const localInputToIso = (value: string) => new Date(value).toISOString();
const formatRange = (startsAt: string, endsAt: string) => {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const date = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} ${time(start)} – ${end.toDateString() === start.toDateString() ? time(end) : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
};

interface Props {
  user: SessionUser | null;
  providers: Doctor[];
  loading: boolean;
  /** Present when the provider list itself failed to load. */
  error: string | null;
  branches: Array<{ id: string; name: string }>;
  /** Re-read the provider list after a change, so the booking picker agrees. */
  onProvidersChanged: () => void;
}

export default function ProviderSetupPanel({ user, providers, loading, error, branches, onProvidersChanged }: Props) {
  const canOnboard = hasPermission(user, 'admin:manage');
  // `schedule:manage` is not in the navigation permission union; read the
  // session grant set directly. Unknown grants fail closed, as everywhere else.
  const canManageSchedule = !!user && (user.effectivePermissions ?? []).includes('schedule:manage');
  const [hoursFor, setHoursFor] = useState<Doctor | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function toggleActive(provider: Doctor) {
    setRowBusy(provider.id);
    setNotice(null);
    try {
      const updated = await providersApi.update(provider.id, { active: !provider.active });
      setNotice({ kind: 'ok', text: `${provider.name} is ${updated.active ? 'on the booking schedule' : 'off the booking schedule'}.` });
      onProvidersChanged();
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err).message });
    } finally {
      setRowBusy(null);
    }
  }

  // The same test the booking picker uses, so the count and the dropdown can
  // never disagree about who is bookable.
  const bookableCount = providers.filter(p => p.active && p.availabilityWindows !== 0).length;

  return (
    <>
      <BentoCard
        title="Providers & availability"
        subtitle="Who the front desk can book, and the hours they can be booked in"
        headerRight={!loading && !error ? <span className="text-xs font-semibold text-t3">{bookableCount} of {providers.length} bookable</span> : undefined}
      >
        {loading ? (
          <ResourceSkeleton label="providers" lines={3} rowClassName="h-12 rounded-xl" />
        ) : error ? (
          <ResourceErrorNotice title="Providers could not be loaded" failure={describeFailure(new Error(error))} compact />
        ) : (
          <div className="space-y-2">
            {notice && (
              <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ${notice.kind === 'ok' ? 'bg-[var(--emerald-soft)] text-emerald-v' : 'bg-[var(--red-soft)] text-red-v'}`}>{notice.text}</p>
            )}

            {providers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--b2)] px-3 py-4 text-center">
                <p className="text-xs font-semibold text-t1">No providers are set up in this clinic.</p>
                <p className="mt-1 text-[11px] text-t3">
                  Appointments are booked against a provider&rsquo;s open hours, so until one exists the front desk cannot book anything.
                  {!canOnboard && ' Ask a clinic owner or administrator to add one.'}
                </p>
              </div>
            ) : (
              providers.map(provider => {
                const noHours = provider.availabilityWindows === 0;
                const hoursUnknown = provider.availabilityWindows === null;
                return (
                  <div key={provider.id} className="rounded-xl border border-[var(--b1)] px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-xs font-semibold text-t1">{provider.name}</p>
                      {!provider.active ? (
                        <span className="badge badge-red shrink-0">Deactivated</span>
                      ) : noHours ? (
                        <span className="badge badge-amber shrink-0">No hours</span>
                      ) : hoursUnknown ? (
                        // The list did not carry an hours count; say only what is known.
                        <span className="badge badge-blue shrink-0">On schedule</span>
                      ) : (
                        <span className="badge badge-emerald shrink-0">Bookable</span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-[10px] text-t3">{provider.specialty}</p>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => { setNotice(null); setHoursFor(provider); }}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1 text-[10px] font-semibold text-t2 transition hover:bg-[var(--s3)]"
                        >
                          <CalendarClock className="h-3 w-3" /> {canManageSchedule ? 'Hours' : 'View hours'}
                        </button>
                        {canOnboard && (
                          <button
                            type="button"
                            disabled={rowBusy === provider.id}
                            onClick={() => void toggleActive(provider)}
                            className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1 text-[10px] font-semibold text-t2 transition hover:bg-[var(--s3)] disabled:opacity-40"
                          >
                            {rowBusy === provider.id ? 'Saving…' : provider.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            {canOnboard ? (
              <button
                type="button"
                onClick={() => { setNotice(null); setAddOpen(true); }}
                className="flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--b2)] py-2 text-xs font-semibold text-indigo transition-colors hover:bg-[var(--s3)]"
              >
                <UserPlus className="h-3.5 w-3.5" /> Add provider
              </button>
            ) : (
              <p className="text-[10px] text-t3">Adding or retiring a provider is done by a clinic owner or administrator.</p>
            )}
          </div>
        )}
      </BentoCard>

      {addOpen && (
        <AddProviderModal
          branches={branches}
          onClose={() => setAddOpen(false)}
          onCreated={(name) => { setAddOpen(false); setNotice({ kind: 'ok', text: `${name} was added. Set their working hours so the front desk can book them.` }); onProvidersChanged(); }}
        />
      )}

      {hoursFor && (
        <ProviderHoursModal
          provider={hoursFor}
          canManageSchedule={canManageSchedule}
          onClose={() => setHoursFor(null)}
          onSaved={onProvidersChanged}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Add provider
// ---------------------------------------------------------------------------

function AddProviderModal({ branches, onClose, onCreated }: {
  branches: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [candidates, setCandidates] = useState<ProviderCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const rows = await providersApi.candidates();
        if (active) setCandidates(rows);
      } catch (err) {
        if (active) setLoadError(describeFailure(err).message);
      }
    })();
    return () => { active = false; };
  }, []);

  // Only users the create route will actually accept: clinician-capable, active,
  // and without a provider profile already.
  const selectable = useMemo(() => (candidates ?? []).filter(c => !c.providerProfileId), [candidates]);
  const selected = selectable.find(c => c.userId === userId) ?? null;
  const branchChoices = useMemo(
    () => (selected ? branches.filter(b => selected.branchIds.includes(b.id)) : []),
    [branches, selected],
  );

  // Derived, not stored: a chosen branch survives only while it is inside the
  // selected clinician's access, so the form can never submit a branch the
  // create route would reject.
  const effectiveBranchId = branchChoices.some(b => b.id === branchId) ? branchId : branchChoices[0]?.id ?? '';

  async function submit() {
    if (!selected || !effectiveBranchId || !specialty.trim()) {
      setFormError('Pick a clinician, a clinic, and a specialty.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await providersApi.create({ userId: selected.userId, branchId: effectiveBranchId, specialty: specialty.trim() });
      onCreated(selected.displayName);
    } catch (err) {
      setFormError(describeFailure(err).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Add provider" onClose={onClose}>
      {formError && <p role="alert" className="mb-2 text-[11px] font-semibold text-red-v">{formError}</p>}
      {loadError ? (
        <ResourceErrorNotice title="Clinician accounts could not be loaded" failure={describeFailure(new Error(loadError))} compact />
      ) : candidates === null ? (
        <ResourceSkeleton label="clinician accounts" lines={2} rowClassName="h-9 rounded-lg" />
      ) : selectable.length === 0 ? (
        <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-3">
          <p className="text-xs font-semibold text-t1">
            {candidates.length === 0
              ? 'No clinician account is available in this workspace.'
              : 'Every clinician account here already has a provider profile.'}
          </p>
          <p className="mt-1 text-[11px] text-t3">
            A provider profile is attached to a user account with a PROVIDER, OWNER or ADMIN role. Create that account first in
            Control Plane &rarr; Users, then add the provider here.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          <select
            aria-label="Clinician" value={userId} onChange={e => setUserId(e.target.value)}
            className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none focus:border-[var(--b3)]"
          >
            <option value="">Select clinician…</option>
            {selectable.map(c => <option key={c.userId} value={c.userId}>{c.displayName} · {c.role}</option>)}
          </select>

          <select
            aria-label="Clinic" value={effectiveBranchId} disabled={!selected} onChange={e => setBranchId(e.target.value)}
            className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-40"
          >
            <option value="">{selected ? 'Select clinic…' : 'Pick a clinician first'}</option>
            {branchChoices.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          {selected && branchChoices.length === 0 && (
            <p role="alert" className="text-[11px] text-amber-v">
              {selected.displayName} has no clinic access that this page can see. Grant clinic access in Control Plane &rarr; Users first.
            </p>
          )}

          <input
            aria-label="Specialty" value={specialty} onChange={e => setSpecialty(e.target.value)} placeholder="Specialty (e.g. Primary Care)"
            className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none focus:border-[var(--b3)]"
          />
          <p className="text-[10px] text-t3">A new provider has no working hours yet, so no slots are offered until you set them.</p>

          <div className="mt-1 flex gap-2">
            <button
              type="button" disabled={saving || !selected || !effectiveBranchId || !specialty.trim()} onClick={() => void submit()}
              className="flex-1 rounded-lg bg-[var(--indigo)] py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {saving ? 'Adding…' : 'Add provider'}
            </button>
            <button type="button" onClick={onClose} className="rounded-lg border border-[var(--b1)] px-4 py-2 text-xs font-semibold text-t2 transition hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Working hours + time off
// ---------------------------------------------------------------------------

function ProviderHoursModal({ provider, canManageSchedule, onClose, onSaved }: {
  provider: Doctor;
  canManageSchedule: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<EditorRow[] | null>(null);
  const [savedSummary, setSavedSummary] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [timeOff, setTimeOff] = useState<TimeOffEntry[] | null>(null);
  const [timeOffError, setTimeOffError] = useState<string | null>(null);
  const [timeOffForm, setTimeOffForm] = useState({ startsAt: '', endsAt: '', reason: '' });
  const [timeOffBusy, setTimeOffBusy] = useState(false);

  const loadTimeOff = useCallback(async () => {
    try {
      const response = await schedulingApi.timeOff(provider.id);
      setTimeOff(response.timeOff);
    } catch (err) {
      setTimeOffError(describeFailure(err).message);
    }
  }, [provider.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await schedulingApi.availability(provider.id);
        if (!active) return;
        const loaded = response.windows
          .filter(w => w.active)
          .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute)
          .map(w => ({ key: `saved-${w.id}`, dayOfWeek: w.dayOfWeek, start: minutesToTime(w.startMinute), end: minutesToTime(w.endMinute), slotMinutes: w.slotMinutes }));
        setRows(loaded);
        setSavedSummary(summariseWindows(response.windows.filter(w => w.active)));
      } catch (err) {
        if (active) setLoadError(describeFailure(err).message);
      }
      if (active) await loadTimeOff();
    })();
    return () => { active = false; };
  }, [provider.id, loadTimeOff]);

  async function save() {
    if (!rows) return;
    const parsed = parseRows(rows);
    if ('error' in parsed) { setFormError(parsed.error); return; }
    setSaving(true);
    setFormError(null);
    try {
      const response = await schedulingApi.saveAvailability(provider.id, parsed.windows);
      // Report what the server stored, not what was typed.
      const stored = response.windows.filter(w => w.active);
      setSavedSummary(summariseWindows(stored));
      setRows(stored
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute)
        .map(w => ({ key: `saved-${w.id}`, dayOfWeek: w.dayOfWeek, start: minutesToTime(w.startMinute), end: minutesToTime(w.endMinute), slotMinutes: w.slotMinutes })));
      onSaved();
    } catch (err) {
      setFormError(describeFailure(err).message);
    } finally {
      setSaving(false);
    }
  }

  async function addTimeOff() {
    if (!timeOffForm.startsAt || !timeOffForm.endsAt) { setTimeOffError('Enter when the time off starts and ends.'); return; }
    setTimeOffBusy(true);
    setTimeOffError(null);
    try {
      await schedulingApi.addTimeOff(provider.id, {
        startsAt: localInputToIso(timeOffForm.startsAt),
        endsAt: localInputToIso(timeOffForm.endsAt),
        reason: timeOffForm.reason.trim() || undefined,
      });
      setTimeOffForm({ startsAt: '', endsAt: '', reason: '' });
      await loadTimeOff();
    } catch (err) {
      setTimeOffError(describeFailure(err).message);
    } finally {
      setTimeOffBusy(false);
    }
  }

  async function removeTimeOff(id: string) {
    setTimeOffBusy(true);
    setTimeOffError(null);
    try {
      await schedulingApi.removeTimeOff(provider.id, id);
      await loadTimeOff();
    } catch (err) {
      setTimeOffError(describeFailure(err).message);
    } finally {
      setTimeOffBusy(false);
    }
  }

  return (
    <ModalShell title={`Working hours · ${provider.name}`} onClose={onClose} wide>
      {!provider.active && (
        <p className="mb-2.5 rounded-lg bg-[var(--red-soft)] px-2.5 py-1.5 text-[11px] font-semibold text-red-v">
          This provider is deactivated. Hours can be prepared now, but no slot is offered and no booking is accepted until they are reactivated.
        </p>
      )}
      <p className="mb-2.5 text-[11px] text-t3">
        Hours are clinic-local and repeat weekly. Saving replaces the whole week. Open slots are computed by the server from these hours minus
        time off and existing appointments.
      </p>

      {loadError ? (
        <ResourceErrorNotice title="Working hours could not be loaded" failure={describeFailure(new Error(loadError))} compact />
      ) : rows === null ? (
        <ResourceSkeleton label="working hours" lines={3} rowClassName="h-9 rounded-lg" />
      ) : (
        <div className="space-y-2">
          {formError && <p role="alert" className="text-[11px] font-semibold text-red-v">{formError}</p>}

          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-[var(--b2)] px-3 py-3 text-center text-[11px] text-t3">
              No working hours are set, so this provider has no open slots and cannot be booked.
            </p>
          )}

          {rows.map(row => (
            <div key={row.key} className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label="Day" value={row.dayOfWeek} disabled={!canManageSchedule}
                onChange={e => setRows(current => (current ?? []).map(r => (r.key === row.key ? { ...r, dayOfWeek: Number(e.target.value) } : r)))}
                className="min-w-[104px] flex-1 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-60"
              >
                {DAY_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
              </select>
              <input
                type="time" aria-label={`${DAY_LABELS[row.dayOfWeek]} start`} value={row.start} disabled={!canManageSchedule}
                onChange={e => setRows(current => (current ?? []).map(r => (r.key === row.key ? { ...r, start: e.target.value } : r)))}
                className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-60"
              />
              <input
                type="time" aria-label={`${DAY_LABELS[row.dayOfWeek]} end`} value={row.end} disabled={!canManageSchedule}
                onChange={e => setRows(current => (current ?? []).map(r => (r.key === row.key ? { ...r, end: e.target.value } : r)))}
                className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-60"
              />
              <select
                aria-label={`${DAY_LABELS[row.dayOfWeek]} appointment length`} value={row.slotMinutes} disabled={!canManageSchedule}
                onChange={e => setRows(current => (current ?? []).map(r => (r.key === row.key ? { ...r, slotMinutes: Number(e.target.value) } : r)))}
                className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-60"
              >
                {SLOT_CHOICES.map(choice => <option key={choice} value={choice}>{choice} min</option>)}
              </select>
              {canManageSchedule && (
                <button
                  type="button" aria-label={`Remove ${DAY_LABELS[row.dayOfWeek]} hours`}
                  onClick={() => setRows(current => (current ?? []).filter(r => r.key !== row.key))}
                  className="rounded-lg border border-[var(--b1)] p-1.5 text-t3 transition hover:bg-[var(--s3)] hover:text-red-v"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}

          {canManageSchedule && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button" onClick={() => setRows(current => {
                  const existing = current ?? [];
                  const nextDay = existing.length ? (existing[existing.length - 1].dayOfWeek + 1) % 7 : 1;
                  return [...existing, newRow(nextDay)];
                })}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1 text-[11px] font-semibold text-t2 transition hover:bg-[var(--s3)]"
              >
                <Plus className="h-3 w-3" /> Add hours
              </button>
              {rows.length === 0 && (
                <button
                  type="button" onClick={() => setRows([1, 2, 3, 4, 5].map(day => newRow(day)))}
                  className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1 text-[11px] font-semibold text-t2 transition hover:bg-[var(--s3)]"
                >
                  Fill Monday–Friday 09:00–17:00
                </button>
              )}
            </div>
          )}

          {savedSummary && (
            <p className="pt-1 text-[10px] text-t3">Currently saved: {savedSummary}</p>
          )}

          {canManageSchedule ? (
            <button
              type="button" disabled={saving} onClick={() => void save()}
              className="mt-1 w-full rounded-lg bg-[var(--indigo)] py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save working hours'}
            </button>
          ) : (
            <p className="text-[10px] text-t3">Working hours are set by a clinic owner, administrator, manager or the provider themselves.</p>
          )}
        </div>
      )}

      {/* ----- Time off ----- */}
      <div className="mt-4 border-t border-[var(--b1)] pt-3">
        <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-t3">
          <CalendarOff className="h-3 w-3" /> Upcoming time off
        </p>
        {timeOffError && <p role="alert" className="mb-2 text-[11px] font-semibold text-red-v">{timeOffError}</p>}
        {timeOff === null ? (
          <ResourceSkeleton label="time off" lines={1} rowClassName="h-8 rounded-lg" />
        ) : timeOff.length === 0 ? (
          <p className="text-[11px] text-t3">No upcoming time off is recorded.</p>
        ) : (
          <div className="space-y-1.5">
            {timeOff.map(entry => (
              <div key={entry.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] px-2.5 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-semibold text-t1">{formatRange(entry.startsAt, entry.endsAt)}</p>
                  {entry.reason && <p className="truncate text-[10px] text-t3">{entry.reason}</p>}
                </div>
                {canManageSchedule && (
                  <button
                    type="button" aria-label="Remove time off" disabled={timeOffBusy} onClick={() => void removeTimeOff(entry.id)}
                    className="rounded-lg border border-[var(--b1)] p-1.5 text-t3 transition hover:bg-[var(--s3)] hover:text-red-v disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {canManageSchedule && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <input
              type="datetime-local" aria-label="Time off starts" value={timeOffForm.startsAt}
              onChange={e => setTimeOffForm(form => ({ ...form, startsAt: e.target.value }))}
              className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-t1 outline-none focus:border-[var(--b3)]"
            />
            <input
              type="datetime-local" aria-label="Time off ends" value={timeOffForm.endsAt}
              onChange={e => setTimeOffForm(form => ({ ...form, endsAt: e.target.value }))}
              className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-t1 outline-none focus:border-[var(--b3)]"
            />
            <input
              aria-label="Time off reason" value={timeOffForm.reason} placeholder="Reason (optional)"
              onChange={e => setTimeOffForm(form => ({ ...form, reason: e.target.value }))}
              className="min-w-[120px] flex-1 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-t1 outline-none focus:border-[var(--b3)]"
            />
            <button
              type="button" disabled={timeOffBusy} onClick={() => void addTimeOff()}
              className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 transition hover:bg-[var(--s3)] disabled:opacity-40"
            >
              {timeOffBusy ? 'Saving…' : 'Add time off'}
            </button>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, onClose, wide = false, children }: {
  title: string; onClose: () => void; wide?: boolean; children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`max-h-[90vh] w-full ${wide ? 'max-w-xl' : 'max-w-md'} overflow-y-auto rounded-2xl border border-[var(--b2)] bg-[var(--s1)] p-5 shadow-xl`}
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <p className="text-sm font-bold text-t1">{title}</p>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1 text-t3 transition hover:bg-[var(--s3)] hover:text-t1">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
