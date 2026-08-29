import { useCallback, useEffect, useState } from 'react';
import { ListChecks, Plus, X } from 'lucide-react';
import BentoCard from '../ui/BentoCard';
import { ResourceErrorNotice, ResourceSkeleton } from '../ui/ResourceSection';
import { describeFailure } from '../../lib/resourceState';
import { activeServices, durationLabel, servicesApi, type ServiceCatalogItem } from '../../lib/services';
import type { SessionUser } from '../../lib/session';

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
                <ul className="space-y-1.5">
                  {items.map(item => (
                    <li key={item.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-t1">{item.name}</p>
                        <p className="text-[11px] text-t3">
                          {durationLabel(item.defaultDurationMinutes)} · {item.category}
                          {item.defaultAppointmentValue != null && ` · ${item.defaultAppointmentValue}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={`badge ${item.active ? 'badge-emerald' : 'badge-red'}`}>{item.active ? 'Bookable' : 'Off'}</span>
                        {canManage && (
                          <button
                            type="button"
                            disabled={rowBusy === item.id}
                            onClick={() => void toggleActive(item)}
                            className="rounded-lg border border-[var(--b1)] px-2 py-1 text-[10px] font-semibold text-t2 hover:bg-[var(--s1)] disabled:opacity-50"
                          >
                            {item.active ? 'Stop offering' : 'Offer again'}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {canManage && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]"
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
  const [form, setForm] = useState({ name: '', category: 'general', defaultDurationMinutes: 30, defaultAppointmentValue: '' });
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
      });
      await onSaved();
    } catch (err) {
      setError(describeFailure(err).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-[var(--b2)] bg-[var(--s1)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm font-bold text-t1"><ListChecks className="h-4 w-4" /> Add a service</p>
          <button type="button" aria-label="Close" onClick={onClose} className="text-t3 hover:text-t1"><X className="h-4 w-4" /></button>
        </div>

        {firstService && (
          <p className="mb-3 rounded-lg bg-[var(--amber-soft)] px-2.5 py-2 text-[11px] font-semibold text-amber-v">
            This is the first service. Once it exists, only services on this list can be booked — anything the
            front desk types that is not here will be refused. Add the rest before they rely on it.
          </p>
        )}
        {error && <p role="alert" className="mb-2 text-[11px] text-red-v">{error}</p>}

        <div className="space-y-2.5">
          <input
            aria-label="Service name"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Service name (e.g. Annual exam)"
            className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none focus:border-[var(--b3)]"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <input
              aria-label="Category"
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              placeholder="Category"
              className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none focus:border-[var(--b3)]"
            />
            <label className="flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1">
              <span className="shrink-0 text-[11px] text-t3">Minutes</span>
              <input
                aria-label="Default duration in minutes"
                type="number" min={5} max={480} step={5}
                value={form.defaultDurationMinutes}
                onChange={e => setForm(f => ({ ...f, defaultDurationMinutes: Number(e.target.value) }))}
                className="w-full bg-transparent outline-none"
              />
            </label>
          </div>
          <input
            aria-label="Default value"
            value={form.defaultAppointmentValue}
            onChange={e => setForm(f => ({ ...f, defaultAppointmentValue: e.target.value }))}
            placeholder="Default value (optional)"
            className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none focus:border-[var(--b3)]"
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s2)]">Cancel</button>
          <button
            type="button"
            disabled={saving || form.name.trim().length < 2}
            onClick={() => void submit()}
            className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Add service'}
          </button>
        </div>
      </div>
    </div>
  );
}
