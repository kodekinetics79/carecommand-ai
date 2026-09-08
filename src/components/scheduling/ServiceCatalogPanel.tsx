import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ListChecks, Plus, X } from 'lucide-react';
import BentoCard from '../ui/BentoCard';
import { ResourceErrorNotice, ResourceSkeleton } from '../ui/ResourceSection';
import { describeFailure } from '../../lib/resourceState';
import { activeServices, durationLabel, servicesApi, type ServiceCatalogItem } from '../../lib/services';
import type { SessionUser } from '../../lib/session';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// ===========================================================================
// Service catalog — the other half of a bookable schedule.
//
// /v1/services has had list, create and update since the module was written and
// nothing in the app ever called it. So every workspace has an empty catalog,
// services are free text a receptionist types, durations arrive from the client
// instead of clinic policy, and two spellings are two services.
//
// The part that makes this urgent rather than merely untidy: the server's
// resolveSchedulingService is fail-closed once the catalog is CONFIGURED. With
// one active item present, any booking whose service does not match an entry
// exactly is refused with "Select an active service" — pointing at a list the
// clinic had no way to see or finish. This panel is that way, and it says out
// loud what creating the first service will do.
// ===========================================================================

const WRITE_ROLES = new Set(['OWNER', 'ADMIN', 'MANAGER']);

interface Props {
  user: SessionUser | null;
  /** Lets the booking form re-read the catalog after a change. */
  onCatalogChanged?: () => void;
}

export default function ServiceCatalogPanel({ user, onCatalogChanged }: Props) {
  const canManage = !!user && WRITE_ROLES.has(user.role);
  const [items, setItems] = useState<ServiceCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [reloadIndex, setReloadIndex] = useState(0);
  // The fetch lives in the effect and every setState happens in its async
  // continuation; calling one synchronously here would cascade a re-render.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const rows = await servicesApi.list();
        if (!active) return;
        setItems(rows);
        setError(null);
      } catch (err) {
        if (active) setError(describeFailure(err).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reloadIndex]);

  const load = useCallback(async () => {
    setLoading(true);
    setReloadIndex(index => index + 1);
  }, []);

  async function toggleActive(item: ServiceCatalogItem) {
    setRowBusy(item.id);
    setNotice(null);
    try {
      const updated = await servicesApi.update(item.id, { active: !item.active });
      setNotice({
        kind: 'ok',
        text: `${updated.name} is ${updated.active ? 'bookable' : 'no longer offered'}.`,
      });
      await load();
      onCatalogChanged?.();
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err).message });
    } finally {
      setRowBusy(null);
    }
  }

  async function toggleVoiceBooking(item: ServiceCatalogItem) {
    setRowBusy(item.id);
    setNotice(null);
    try {
      const updated = await servicesApi.update(item.id, { bookableByVoice: !item.bookableByVoice });
      setNotice({
        kind: 'ok',
        text: `${updated.name} is ${updated.bookableByVoice ? 'now bookable by the AI receptionist' : 'now staff-booking only'}.`,
      });
      await load();
      onCatalogChanged?.();
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err).message });
    } finally {
      setRowBusy(null);
    }
  }

  const live = activeServices(items);
  const governs = live.length > 0;

  return (
    <>
      <BentoCard
        title="Services"
        subtitle="What the clinic offers, and how long each visit takes"
        headerRight={!loading && !error ? <span className="text-xs font-semibold text-t3">{live.length} bookable</span> : undefined}
      >
        {loading ? (
          <ResourceSkeleton label="services" lines={3} rowClassName="h-11 rounded-xl" />
        ) : error ? (
          <ResourceErrorNotice title="Services could not be loaded" failure={describeFailure(new Error(error))} onRetry={() => void load()} compact />
        ) : (
          <div className="space-y-2">
            {notice && (
              <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ${notice.kind === 'ok' ? 'bg-[var(--emerald-soft)] text-emerald-v' : 'bg-[var(--red-soft)] text-red-v'}`}>{notice.text}</p>
            )}

            {items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--b1)] p-3">
                <p className="text-[11px] font-semibold text-t2">No services defined.</p>
                <p className="mt-1 text-[11px] text-t3">
                  Bookings currently accept any service the front desk types, at 30 minutes each.
                  {canManage
                    ? ' Adding the first service turns that off: from then on only services on this list can be booked, so add all of them before the desk relies on it.'
                    : ' A clinic owner or administrator defines the list.'}
                </p>
              </div>
            ) : (
              <>
                {!governs && (
                  <p className="rounded-lg bg-[var(--amber-soft)] px-2.5 py-1.5 text-[11px] font-semibold text-amber-v">
                    Every service is switched off, so bookings fall back to free text at 30 minutes.
                  </p>
                )}
                <ul className="space-y-2">
                  {items.map(item => (
                    <li key={item.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2 transition hover:border-[var(--b2)] overflow-hidden">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-bold text-t1" title={item.name}>{item.name}</p>
                          <p className="text-[11px] text-t3 truncate">
                            {durationLabel(item.defaultDurationMinutes)} · {item.category}
                            {item.defaultAppointmentValue != null && ` · $${item.defaultAppointmentValue}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`badge ${item.active ? 'badge-emerald' : 'badge-red'}`}>{item.active ? 'Bookable' : 'Off'}</span>
                          <span className={`badge ${item.bookableByVoice ? 'badge-blue' : 'badge-slate'}`}>{item.bookableByVoice ? 'AI voice' : 'Staff only'}</span>
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-2 pt-2 border-t border-[var(--b1)]/60">
                          <button
                            type="button"
                            disabled={rowBusy === item.id}
                            onClick={() => void toggleVoiceBooking(item)}
                            className="flex-1 min-w-0 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-[10px] font-semibold text-t2 hover:bg-[var(--s3)] hover:text-t1 transition disabled:opacity-50 text-center truncate"
                          >
                            {item.bookableByVoice ? 'Disable AI booking' : 'Enable AI booking'}
                          </button>
                          <button
                            type="button"
                            disabled={rowBusy === item.id}
                            onClick={() => void toggleActive(item)}
                            className="flex-1 min-w-0 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-[10px] font-semibold text-t2 hover:bg-[var(--s3)] hover:text-t1 transition disabled:opacity-50 text-center truncate"
                          >
                            {item.active ? 'Stop offering' : 'Offer again'}
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {canManage && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition"
              >
                <Plus className="h-3.5 w-3.5" /> Add a service
              </button>
            )}
          </div>
        )}
      </BentoCard>

      {addOpen && (
        <AddServiceModal
          firstService={items.length === 0}
          onClose={() => setAddOpen(false)}
          onSaved={async () => {
            setAddOpen(false);
            await load();
            onCatalogChanged?.();
          }}
        />
      )}
    </>
  );
}

function AddServiceModal({ firstService, onClose, onSaved }: {
  firstService: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onClose });

  const [form, setForm] = useState({
    name: '', category: 'general', defaultDurationMinutes: 30, defaultAppointmentValue: '',
    spokenDescription: '', bookableByVoice: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const value = form.defaultAppointmentValue.trim();
      await servicesApi.create({
        name: form.name.trim(),
        category: form.category.trim() || 'general',
        defaultDurationMinutes: form.defaultDurationMinutes,
        defaultAppointmentValue: value ? Number(value) : null,
        spokenDescription: form.spokenDescription.trim() || null,
        bookableByVoice: form.bookableByVoice,
      });
      await onSaved();
    } catch (err) {
      setError(describeFailure(err).message);
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-service-title"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity animate-fade-in"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--b2)] bg-[var(--s1)] shadow-2xl animate-fade-up my-auto flex flex-col max-h-[92vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--b1)] p-5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--indigo-soft)] text-indigo">
              <ListChecks className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="add-service-title" className="text-base font-bold text-t1">Add Service</h2>
              <p className="mt-0.5 text-xs text-t3">Define a clinical service and configure booking availability.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-t3 hover:bg-[var(--s2)] hover:text-t1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--indigo)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
          className="p-5 space-y-4 overflow-y-auto flex-1"
        >
          {firstService && (
            <div role="status" className="rounded-xl border border-amber-500/30 bg-[var(--amber-soft)] p-3 text-xs font-medium text-amber-v leading-relaxed">
              This is the first service. Once it exists, only services on this list can be booked — anything typed that is not here will be refused. Add all clinic services before staff relies on it.
            </div>
          )}

          {error && (
            <div role="alert" className="flex items-center gap-2.5 rounded-xl border border-red-500/40 bg-[var(--red-soft)] px-3.5 py-2.5 text-xs font-semibold text-red-v">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-v" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="service-name" className="block text-xs font-semibold text-t2 mb-1.5">
              Service name <span className="text-red-v">*</span>
            </label>
            <input
              id="service-name"
              aria-label="Service name"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Annual Health Check, Routine Consultation"
              required
              className="w-full px-3 py-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none transition focus:border-[var(--indigo)] focus:ring-2 focus:ring-[var(--indigo)]/20 placeholder:text-t3 font-medium"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="service-category" className="block text-xs font-semibold text-t2 mb-1.5">
                Category
              </label>
              <input
                id="service-category"
                aria-label="Category"
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                placeholder="general, follow-up, procedure"
                className="w-full px-3 py-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none transition focus:border-[var(--indigo)] focus:ring-2 focus:ring-[var(--indigo)]/20 placeholder:text-t3"
              />
            </div>
            <div>
              <label htmlFor="service-duration" className="block text-xs font-semibold text-t2 mb-1.5">
                Duration (minutes) <span className="text-red-v">*</span>
              </label>
              <input
                id="service-duration"
                aria-label="Default duration in minutes"
                type="number"
                min={5}
                max={480}
                step={5}
                value={form.defaultDurationMinutes}
                onChange={e => setForm(f => ({ ...f, defaultDurationMinutes: Number(e.target.value) }))}
                className="w-full px-3 py-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none transition focus:border-[var(--indigo)] focus:ring-2 focus:ring-[var(--indigo)]/20"
              />
            </div>
          </div>

          <div>
            <label htmlFor="service-value" className="block text-xs font-semibold text-t2 mb-1.5">
              Default appointment value ($)
            </label>
            <input
              id="service-value"
              aria-label="Default value"
              type="number"
              min={0}
              step={0.01}
              value={form.defaultAppointmentValue}
              onChange={e => setForm(f => ({ ...f, defaultAppointmentValue: e.target.value }))}
              placeholder="e.g. 150 (optional)"
              className="w-full px-3 py-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none transition focus:border-[var(--indigo)] focus:ring-2 focus:ring-[var(--indigo)]/20 placeholder:text-t3"
            />
          </div>

          <div>
            <label htmlFor="service-spoken" className="block text-xs font-semibold text-t2 mb-1.5">
              Spoken description for AI Receptionist
            </label>
            <input
              id="service-spoken"
              aria-label="Caller-facing service description"
              value={form.spokenDescription}
              onChange={e => setForm(f => ({ ...f, spokenDescription: e.target.value }))}
              placeholder="How the voice agent explains this to callers (optional)"
              className="w-full px-3 py-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none transition focus:border-[var(--indigo)] focus:ring-2 focus:ring-[var(--indigo)]/20 placeholder:text-t3"
            />
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 cursor-pointer hover:bg-[var(--s3)] transition">
            <input
              aria-label="Allow AI receptionist booking"
              type="checkbox"
              checked={form.bookableByVoice}
              onChange={e => setForm(f => ({ ...f, bookableByVoice: e.target.checked }))}
              className="mt-1 h-4 w-4 rounded border-[var(--b2)] text-[var(--indigo)] focus:ring-[var(--indigo)]"
            />
            <div className="text-xs">
              <span className="font-semibold text-t1">Allow AI receptionist booking</span>
              <p className="mt-0.5 text-[11px] text-t3 leading-normal">Enables automated booking over phone calls for this service once providers and schedules are configured.</p>
            </div>
          </label>

          <div className="flex items-center justify-end gap-2.5 border-t border-[var(--b1)] pt-4 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[var(--b1)] px-4 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s2)] transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || form.name.trim().length < 2}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Add service'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
