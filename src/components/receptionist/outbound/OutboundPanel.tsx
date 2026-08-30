import { useCallback, useEffect, useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { useSession } from '../../../hooks/useSession';
import { receptionistApi as api, type Clinic, type Campaign, type VoiceLineStatus, type OutboundCampaign, type BookingRequest, type ConfirmationDelivery, type OutboundControlStatus, type OutboundStopResult } from '../../../lib/receptionist';
import { formatEnumLabel } from '../helpers';
import { OutboundStopCard } from './OutboundStopCard';
import { VoiceLineStatusCard } from './VoiceLineStatusCard';
import { CampaignBuilder } from './CampaignBuilder';
import { CampaignDetail } from './CampaignDetail';
import { BookingRequestQueue } from './BookingRequestQueue';
import { ConfirmationDeliveryQueue } from './ConfirmationDeliveryQueue';

// ===========================================================================
// Outbound calling panel: voice line status, campaign builder, target list,
// test-call launcher, call logs, and the appointment-request review queue.
// ===========================================================================

export function OutboundPanel({ clinic }: { clinic: Clinic }) {
  const { user } = useSession();
  const [status, setStatus] = useState<VoiceLineStatus | null>(null);
  const [control, setControl] = useState<OutboundControlStatus | null>(null);
  const [stopResult, setStopResult] = useState<OutboundStopResult | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [campaigns, setCampaigns] = useState<OutboundCampaign[]>([]);
  const [bookingAuthorities, setBookingAuthorities] = useState<Campaign[]>([]);
  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [deliveries, setDeliveries] = useState<ConfirmationDelivery[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const results = await Promise.allSettled([
      api.voiceLineStatus(),
      api.listOutboundCampaigns(clinic.id),
      api.listBookingRequests(),
      api.listCampaigns(clinic.id),
      api.listConfirmationDeliveries(),
      api.outboundControl(),
    ]);
    const labels = ['voice line status', 'outbound campaigns', 'appointment requests', 'booking authorities', 'confirmation delivery evidence', 'emergency-stop status'];
    setLoadErrors(results.flatMap((result, index) => result.status === 'rejected' ? [`${labels[index]} could not be loaded.`] : []));
    const [st, camps, reqs, authorities, confirmationRows, controlResult] = results;
    if (st.status === 'fulfilled') setStatus(st.value);
    if (camps.status === 'fulfilled') {
      setCampaigns(camps.value);
      setSelectedId(prev => (prev && camps.value.some(c => c.id === prev) ? prev : camps.value[0]?.id ?? ''));
    }
    if (reqs.status === 'fulfilled') setRequests(reqs.value);
    if (authorities.status === 'fulfilled') setBookingAuthorities(authorities.value.filter(c => c.status === 'ACTIVE'));
    if (confirmationRows.status === 'fulfilled') setDeliveries(confirmationRows.value);
    if (controlResult.status === 'fulfilled') setControl(controlResult.value);
    else setControl(null);
    setLoading(false);
  }, [clinic.id]);

  useEffect(() => {
    void (async () => { await reload(); })();
  }, [reload]);

  const selected = campaigns.find(c => c.id === selectedId) ?? null;
  const canStop = user ? ['OWNER', 'ADMIN'].includes(user.role) : false;

  async function stopOutbound(reason: string) {
    if (reason.trim().length < 5) throw new Error('Enter at least five characters for the stop reason.');
    setStopping(true); setStopError(null); setStopResult(null);
    try {
      const result = await api.stopOutbound(reason);
      setStopResult(result);
      setControl({ stopped: true, reason, changedAt: new Date().toISOString() });
      await reload();
    } catch (error) {
      setStopError(error instanceof Error ? error.message : 'Emergency stop could not be confirmed. Verify status before any launch.');
      await reload();
    } finally {
      setStopping(false);
    }
  }

  if (loading) return <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;

  return (
    <div className="space-y-5">
      <VoiceLineStatusCard status={status} />
      <OutboundStopCard control={control} result={stopResult} canStop={canStop} stopping={stopping} error={stopError} onStop={stopOutbound} onRetry={reload} />
      {loadErrors.length > 0 && (
        <div role="alert" className="cc-card border-l-4 border-l-red-v p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-red-v">Outbound data is incomplete</p>
              <p className="text-xs text-t3 mt-1">{loadErrors.join(' ')} Existing data is preserved; empty results are not assumed.</p>
            </div>
            <button type="button" onClick={() => void reload()} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Retry</button>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-[260px_1fr] gap-5">
        {/* Campaign list */}
        <div className="cc-card p-3 space-y-1.5 h-max">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-t3">Campaigns</span>
            <button type="button" aria-label="New outbound campaign" title="New outbound campaign" onClick={() => { setCreating(true); setSelectedId(''); }} className="text-indigo hover:opacity-80"><Plus className="w-4 h-4" /></button>
          </div>
          {campaigns.length === 0 && !creating && loadErrors.length === 0 && <p className="px-1 py-3 text-xs text-t3">No outbound campaigns yet.</p>}
          {campaigns.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => { setSelectedId(c.id); setCreating(false); }}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${selectedId === c.id && !creating ? 'bg-[var(--s2)] text-t1' : 'text-t2 hover:bg-[var(--s2)]'}`}
            >
              <span className="block font-semibold truncate">{c.name}</span>
              <span className="text-[10px] text-t3">{formatEnumLabel(c.status)} · {c._count?.targets ?? 0} targets · {c._count?.callLogs ?? 0} calls</span>
            </button>
          ))}
        </div>

        {/* Builder / detail */}
        <div className="space-y-5">
          {creating && (
            <CampaignBuilder
              clinicId={clinic.id}
              bookingAuthorities={bookingAuthorities}
              locations={clinic.locations ?? []}
              timezone={clinic.timezone}
              onCancel={() => setCreating(false)}
              onSaved={async (id) => { setCreating(false); await reload(); setSelectedId(id); }}
            />
          )}
          {!creating && selected && (
            <CampaignDetail key={selected.id} campaign={selected} status={status} outboundStopped={control?.stopped !== false} onChanged={reload} />
          )}
          {!creating && !selected && (
            <div className="cc-card p-10 text-center text-sm text-t3">Select a campaign or create one to configure outbound calls.</div>
          )}
        </div>
      </div>

      <BookingRequestQueue requests={requests} onChanged={reload} />
      <ConfirmationDeliveryQueue deliveries={deliveries} loadFailed={loadErrors.some(error => error.startsWith('confirmation delivery evidence'))} onRetry={reload} />
    </div>
  );
}
