import { useMemo, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Field, TextInput } from '../../ui/Field';
import { getLocale } from '../../../lib/preferences';
import { receptionistApi as api, type BookingRequest, type BookingRequestStatus } from '../../../lib/receptionist';
import { formatEnumLabel } from '../helpers';
import { ConfirmedButton } from '../shared';

const requestBadge: Record<BookingRequestStatus, string> = {
  PENDING_REVIEW: 'badge badge-amber', BOOKED: 'badge badge-emerald', REJECTED: 'badge badge-red',
  MISSING_INFO: 'badge badge-violet', DUPLICATE: 'badge badge-blue',
};

type CanonicalBookingDisplay = {
  service: string;
  startsAt: string;
  timezone: string;
  locationName: string;
  locationAddress: string | null;
  providerName: string | null;
};

export function BookingRequestQueue({ requests, onChanged }: { requests: BookingRequest[]; onChanged: () => void | Promise<void> }) {
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [appointmentId, setAppointmentId] = useState('');
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconciledCanonicalByRequest, setReconciledCanonicalByRequest] = useState<Record<string, CanonicalBookingDisplay>>({});
  const canonicalByRequest = useMemo(() => {
    const canonical: Record<string, CanonicalBookingDisplay> = {};
    for (const request of requests) {
      if (!request.bookedAppointment) continue;
      canonical[request.id] = {
        service: request.bookedAppointment.service,
        startsAt: request.bookedAppointment.startsAt,
        timezone: request.bookedAppointment.branch.timezone,
        locationName: request.bookedAppointment.branch.name,
        locationAddress: request.bookedAppointment.branch.location.trim() || null,
        providerName: request.bookedAppointment.providerProfile?.user.displayName ?? null,
      };
    }
    return { ...canonical, ...reconciledCanonicalByRequest };
  }, [requests, reconciledCanonicalByRequest]);

  async function reject(id: string, outcomeReason: string) {
    setBusy(true); setError(null);
    try {
      await api.updateBookingRequest(id, { status: 'REJECTED', outcomeReason });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The rejection was not recorded.');
    } finally { setBusy(false); }
  }

  async function reconcile(id: string) {
    setBusy(true); setError(null);
    try {
      const result = await api.reconcileBookingRequest(id, {
        appointmentId: appointmentId.trim(), outcomeReason: reason.trim(), acknowledgeRequestDifferences: true,
      });
      setReconciledCanonicalByRequest(current => ({ ...current, [id]: result.appointment }));
      setReconcilingId(null); setAppointmentId(''); setReason(''); setAcknowledged(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The appointment link was not recorded.');
    } finally { setBusy(false); }
  }
  return (
    <div className="cc-card p-5">
      <h3 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><CalendarClock className="w-4 h-4 text-indigo" /> Appointment requests ({requests.length})</h3>
      {requests.length === 0 ? <p className="text-xs text-t3">No appointment requests collected yet. They appear here after calls complete.</p> : (
        <div className="space-y-2">
          {requests.map(r => {
            const canonical = canonicalByRequest[r.id];
            return (
            <div key={r.id} className="rounded-lg border border-[var(--b1)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={requestBadge[r.status]}>{formatEnumLabel(r.status)}</span>
                  <span className="text-sm text-t1 font-semibold truncate">{r.collectedName || r.collectedPhone || 'Unknown contact'}</span>
                  {r.status !== 'BOOKED' && r.requestedService && <span className="text-xs text-t3 truncate">· Requested: {r.requestedService}</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {['PENDING_REVIEW', 'MISSING_INFO'].includes(r.status) && (
                    <>
                      <button type="button" disabled={busy} onClick={() => window.open('/scheduling', '_blank', 'noopener,noreferrer')} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s2)]">Open scheduler</button>
                      <button type="button" disabled={busy} onClick={() => { setReconcilingId(r.id); setAppointmentId(''); setReason(''); setAcknowledged(false); setError(null); }} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-emerald-v hover:bg-[var(--s2)]">Link canonical appointment</button>
                      <ConfirmedButton
                        dialogTitle="Reject appointment request?"
                        message="Record why this request cannot proceed. This changes the request status; it does not cancel or modify an appointment."
                        confirmLabel="Reject request"
                        tone="red"
                        requireReason
                        reasonLabel="Rejection reason"
                        disabled={busy}
                        onConfirm={outcomeReason => reject(r.id, outcomeReason)}
                        className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--s2)] disabled:opacity-50"
                      >Reject</ConfirmedButton>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-t3">
                {r.status === 'BOOKED' && canonical ? (
                  <span className="font-semibold text-emerald-v">
                    Booked: {canonical.service} · {new Date(canonical.startsAt).toLocaleString(getLocale(), { timeZone: canonical.timezone })} {canonical.timezone}
                    {' · '}{[canonical.locationName, canonical.locationAddress].filter(Boolean).join(', ')}
                    {canonical.providerName ? ` · ${canonical.providerName}` : ''}
                  </span>
                ) : r.status === 'BOOKED' ? (
                  <span className="font-semibold text-red-v">Canonical appointment details unavailable—refresh before relying on this booking.</span>
                ) : r.requestedDateTime ? <span>Requested: {new Date(r.requestedDateTime).toLocaleString()}</span> : null}
                {r.collectedPhone && <span>{r.collectedPhone}</span>}
                {r.missingFields.length > 0 && <span className="text-amber-v">Missing: {r.missingFields.join(', ')}</span>}
                {r.outcomeReason && <span className="italic">{r.outcomeReason}</span>}
              </div>
              {reconcilingId === r.id && (
                <div role="dialog" aria-label="Link canonical appointment" className="mt-3 rounded-lg border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2">
                  <p className="text-xs font-bold text-t1">Reconcile to an appointment created in the canonical scheduler</p>
                  <p className="text-[11px] text-t3">This does not create or fake a booking. The server verifies the exact tenant, branch, patient, provider, appointment state, source-call binding, and one-request ownership before changing the queue.</p>
                  <Field label="Canonical appointment ID" required><TextInput value={appointmentId} onChange={event => setAppointmentId(event.target.value)} placeholder="UUID from the appointment record" /></Field>
                  <Field label="Reconciliation reason" required><TextInput value={reason} onChange={event => setReason(event.target.value)} placeholder="Scheduled by front desk after caller review" /></Field>
                  <label className="flex items-start gap-2 text-[11px] text-t2">
                    <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
                    I reviewed any requested service/time differences and confirm this is the exact canonical appointment for this request.
                  </label>
                  <div className="flex gap-2">
                    <button type="button" disabled={busy || !acknowledged || reason.trim().length < 5 || !/^[0-9a-f-]{36}$/i.test(appointmentId.trim())} onClick={() => void reconcile(r.id)} className="rounded-lg bg-indigo px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{busy ? 'Linking…' : 'Link appointment'}</button>
                    <button type="button" disabled={busy} onClick={() => { setReconcilingId(null); setError(null); }} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Cancel</button>
                  </div>
                </div>
              )}
            </div>
            );
          })}
          {error && <p role="alert" className="text-xs font-semibold text-red-v">{error} Refresh before taking another action.</p>}
        </div>
      )}
    </div>
  );
}
