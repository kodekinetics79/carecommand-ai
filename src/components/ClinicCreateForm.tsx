import { useId, useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { apiRequest } from '../lib/api';

export default function ClinicCreateForm({ canCreate, onCreated }: { canCreate: boolean; onCreated: () => void }) {
  const id = useId();
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', location: '', timezone: 'America/New_York' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await apiRequest<{ name: string }>('/v1/branches', { method: 'POST', body: JSON.stringify({ name: draft.name.trim(), location: draft.location.trim(), timezone: draft.timezone.trim() }) });
      setSuccess(`${created.name} was created. Next, assign staff and configure provider schedules and receptionist routing.`);
      setDraft({ name: '', location: '', timezone: draft.timezone });
      setOpen(false);
      onCreated();
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'The clinic could not be saved.'} Refresh the clinic list before retrying if the connection was interrupted.`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!canCreate) return null;
  const fieldClass = 'mt-1 block w-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500';
  return <section className="mb-4 space-y-3" aria-label="Add a practice clinic">
    {success ? <p role="status" className="text-sm text-t2">{success}</p> : null}
    <button type="button" aria-expanded={open} aria-controls={`${id}-form`} disabled={busy} onClick={() => { setOpen(!open); setError(null); }} className="btn-primary inline-flex items-center gap-2">
      <Plus className="h-4 w-4" aria-hidden="true" />{open ? 'Close clinic form' : 'Add clinic'}
    </button>
    {open ? <form id={`${id}-form`} onSubmit={event => void submit(event)} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-4">
      <p className="mb-4 text-sm text-t2">Add a scheduling location in this workspace. This does not assign staff, activate a phone line, or send invitations.</p>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">New clinic details</legend>
        <label htmlFor={`${id}-name`} className="text-xs font-semibold text-t2">Clinic name
          <input id={`${id}-name`} className={fieldClass} required minLength={2} maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label htmlFor={`${id}-location`} className="text-xs font-semibold text-t2">Address or location
          <input id={`${id}-location`} className={fieldClass} required minLength={2} maxLength={240} value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} />
        </label>
        <div className="text-xs font-semibold text-t2">
          <label htmlFor={`${id}-timezone`}>Clinic timezone</label>
          <input id={`${id}-timezone`} className={fieldClass} required maxLength={80} list={`${id}-zones`} aria-describedby={`${id}-timezone-help`} value={draft.timezone} onChange={e => setDraft({ ...draft, timezone: e.target.value })} />
          <datalist id={`${id}-zones`}>{['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London'].map(zone => <option key={zone} value={zone} />)}</datalist>
          <span id={`${id}-timezone-help`} className="mt-1 block font-normal text-t3">Use an IANA timezone, such as America/Los_Angeles. Schedules use this clinic’s local time.</span>
        </div>
      </fieldset>
      {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={busy} className="btn-primary mt-4">{busy ? 'Creating clinic…' : 'Create clinic'}</button>
    </form> : null}
  </section>;
}
