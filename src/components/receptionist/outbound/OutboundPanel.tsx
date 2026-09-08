import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { CalendarClock, Loader2, Megaphone, PhoneCall, Plus, Settings2 } from 'lucide-react';
import { Link } from 'react-router';
import { useSession } from '../../../hooks/useSession';
import { receptionistApi as api, type Clinic, type Campaign, type VoiceLineStatus, type OutboundCampaign, type BookingRequest, type ConfirmationDelivery, type OutboundControlStatus, type OutboundStopResult } from '../../../lib/receptionist';
import { formatEnumLabel } from '../helpers';
import { OutboundStopCard } from './OutboundStopCard';
import { VoiceLineStatusCard } from './VoiceLineStatusCard';
import { CampaignBuilder } from './CampaignBuilder';
import { CampaignDetail } from './CampaignDetail';
import { BookingRequestQueue } from './BookingRequestQueue';
import { ConfirmationDeliveryQueue } from './ConfirmationDeliveryQueue';
import { normalizeVoiceLineStatus } from '../../../lib/receptionistDeployment';

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
  const [draftPurpose, setDraftPurpose] = useState<'CARE_COORDINATION' | 'APPOINTMENT_REMINDER'>('CARE_COORDINATION');
  const [workspace, setWorkspace] = useState<'lists' | 'appointments' | 'marketing' | 'setup'>('lists');
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

  const operationalCampaigns = workspace === 'appointments'
    ? campaigns.filter(campaign => campaign.purpose === 'APPOINTMENT_REMINDER')
    : workspace === 'lists'
      ? campaigns.filter(campaign => campaign.purpose !== 'APPOINTMENT_REMINDER')
      : campaigns;
  const selected = operationalCampaigns.find(c => c.id === selectedId) ?? operationalCampaigns[0] ?? null;
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

  // These are the three jobs a clinic operator comes here to do. Calling Setup
  // is deliberately separate below: infrastructure is a utility destination,
  // not a fourth daily workflow competing with patient work.
  const tabs = [
    { id: 'lists' as const, label: 'Existing patients', icon: PhoneCall },
    { id: 'appointments' as const, label: 'Appointment reminders', icon: CalendarClock },
    { id: 'marketing' as const, label: 'Marketing campaigns', icon: Megaphone },
  ];
  const voiceLine = status ? normalizeVoiceLineStatus(status) : null;
  const callingStatus = control?.stopped !== false
    ? { label: 'Outgoing calls paused', className: 'text-red-v bg-[var(--red-soft)]' }
    : voiceLine?.providerConfigured
      ? { label: 'Calling setup complete', className: 'text-emerald-v bg-[var(--emerald-soft)]' }
      : { label: 'Finish calling setup', className: 'text-amber-v bg-[var(--amber-soft)]' };

  function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const id = tabs[next].id;
    setWorkspace(id);
    setCreating(false);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#outreach-tab-${id}`)?.focus();
  }

  return (
    <div className="space-y-5">
      <section className="glass-card overflow-hidden p-4 sm:p-5" aria-labelledby="outreach-title">
        <div className="relative z-[1] flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="outreach-title" className="text-xl font-bold tracking-[-0.02em] text-t1">Patient outreach</h2>
              <p className="mt-1 max-w-2xl text-sm text-t3">Choose who needs contact, use the right follow-up flow, and see what happened.</p>
            </div>
            <button id="outreach-setup-control" type="button" aria-pressed={workspace === 'setup'} onClick={() => { setWorkspace('setup'); setCreating(false); }} className={`inline-flex min-h-11 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${callingStatus.className}`}><Settings2 className="h-3.5 w-3.5" aria-hidden="true" />{callingStatus.label}</button>
          </div>
          <div role="tablist" aria-label="Patient outreach sections" className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-white/70 bg-white/60 p-1 shadow-sm">
            {tabs.map((item, index) => {
              const Icon = item.icon;
              return <button key={item.id} id={`outreach-tab-${item.id}`} role="tab" aria-selected={workspace === item.id} aria-controls={`outreach-panel-${item.id}`} tabIndex={workspace === item.id ? 0 : -1} type="button" onKeyDown={event => moveTabFocus(event, index)} onClick={() => { setWorkspace(item.id); setCreating(false); }} className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition ${workspace === item.id ? 'bg-[var(--s1)] text-t1 shadow-sm' : 'text-t3 hover:text-t1'}`}><Icon className="h-3.5 w-3.5" aria-hidden="true" />{item.label}</button>;
            })}
          </div>
        </div>
      </section>
      {loadErrors.length > 0 && (
        <div role="alert" className="cc-card border border-red-v/30 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-red-v">Outbound data is incomplete</p>
              <p className="text-xs text-t3 mt-1">{loadErrors.join(' ')} Existing data is preserved; empty results are not assumed.</p>
            </div>
            <button type="button" onClick={() => void reload()} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Retry</button>
          </div>
        </div>
      )}

      {(workspace === 'lists' || workspace === 'appointments') && <div id={`outreach-panel-${workspace}`} role="tabpanel" aria-labelledby={`outreach-tab-${workspace}`} className="space-y-5">
      {workspace === 'appointments' && <div className="rounded-xl border border-amber-v/30 bg-[var(--amber-soft)] p-3 text-xs text-t2"><p className="font-bold text-t1">Manual calling today</p><p className="mt-1">Choose patients and use Call one at a time. Automatic call/SMS reminders and provider-unavailable rebooking are not connected yet, so approving a list does not schedule or dispatch anything.</p></div>}
      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Campaign list */}
        <div className="cc-card p-3 space-y-1.5 h-max">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-t3">{workspace === 'appointments' ? 'Reminder lists' : 'Calling lists'}</span>
            <button type="button" onClick={() => { setDraftPurpose(workspace === 'appointments' ? 'APPOINTMENT_REMINDER' : 'CARE_COORDINATION'); setCreating(true); setSelectedId(''); }} className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-indigo hover:opacity-80"><Plus className="w-4 h-4" /> New list</button>
          </div>
          {operationalCampaigns.length === 0 && loadErrors.length === 0 && <div className="px-1 py-4"><p className="text-xs font-semibold text-t2">No {workspace === 'appointments' ? 'appointment reminder lists' : 'calling lists'} yet.</p><button type="button" onClick={() => { setDraftPurpose(workspace === 'appointments' ? 'APPOINTMENT_REMINDER' : 'CARE_COORDINATION'); setCreating(true); setSelectedId(''); }} className="mt-2 min-h-11 text-xs font-semibold text-indigo">Create a list</button></div>}
          {operationalCampaigns.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => { setSelectedId(c.id); setCreating(false); }}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${selected?.id === c.id && !creating ? 'bg-[var(--s2)] text-t1' : 'text-t2 hover:bg-[var(--s2)]'}`}
            >
              <span className="block font-semibold truncate">{c.name}</span>
              <span className="text-[10px] text-t3">{formatEnumLabel(c.status)} · {c._count?.targets ?? 0} targets · {c._count?.callLogs ?? 0} calls</span>
            </button>
          ))}
        </div>

        {/* Builder / detail */}
        <div className="space-y-5">
          {creating && <CampaignBuilder clinicId={clinic.id} bookingAuthorities={bookingAuthorities} locations={clinic.locations ?? []} timezone={clinic.timezone} initialPurpose={draftPurpose} onCancel={() => setCreating(false)} onSaved={async id => { setCreating(false); await reload(); setSelectedId(id); }} />}
          {!creating && selected && (
            <CampaignDetail key={selected.id} campaign={selected} status={status} outboundStopped={control?.stopped !== false} onChanged={reload} mode="operations" />
          )}
          {!creating && !selected && (
            <div className="cc-card p-10 text-center text-sm text-t3">Choose a list or create one to get started.</div>
          )}
        </div>
      </div>

      {workspace === 'appointments' && <>
        <BookingRequestQueue requests={requests} onChanged={reload} />
        <ConfirmationDeliveryQueue deliveries={deliveries} loadFailed={loadErrors.some(error => error.startsWith('confirmation delivery evidence'))} onRetry={reload} />
        <div className="cc-card flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-bold text-t1">Manage appointments</p><p className="mt-1 text-xs text-t3">Book, move, or cancel the canonical visit from Scheduling.</p></div><Link to="/scheduling" className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-indigo">Open Scheduling</Link></div>
      </>}
      </div>}

      {workspace === 'marketing' && (
        <div id="outreach-panel-marketing" role="tabpanel" aria-labelledby="outreach-tab-marketing" className="cc-card p-6 sm:p-8">
          <div className="max-w-2xl">
            <Megaphone className="h-8 w-8 text-indigo" aria-hidden="true" />
            <h3 className="mt-4 text-xl font-bold tracking-[-0.02em] text-t1">Marketing campaigns</h3>
            <p className="mt-2 text-sm leading-6 text-t3">Build a governed audience, preview exclusions, approve the message, and review delivery evidence in the Marketing workspace. Voice stays unavailable there until it is connected to the same safe calling runtime.</p>
            <Link to="/campaigns" className="mt-5 inline-flex rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white">Open Marketing</Link>
          </div>
        </div>
      )}

      {workspace === 'setup' && <div id="outreach-panel-setup" role="region" aria-labelledby="outreach-setup-control" className="space-y-5">
        <VoiceLineStatusCard status={status} />
        <OutboundStopCard control={control} result={stopResult} canStop={canStop} stopping={stopping} error={stopError} onStop={stopOutbound} onRetry={reload} />
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          <div className="cc-card h-max space-y-1.5 p-3">
            <div className="px-1 pb-1"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Advanced list settings</span></div>
            {campaigns.map(campaign => <button key={campaign.id} type="button" onClick={() => { setSelectedId(campaign.id); setCreating(false); }} className={`w-full rounded-lg px-2.5 py-2 text-left text-sm ${selected?.id === campaign.id && !creating ? 'bg-[var(--s2)] text-t1' : 'text-t2 hover:bg-[var(--s2)]'}`}><span className="block truncate font-semibold">{campaign.name}</span><span className="text-[10px] text-t3">{formatEnumLabel(campaign.status)} · {campaign._count?.targets ?? 0} people</span></button>)}
          </div>
          <div className="space-y-5">
            {selected && <CampaignDetail key={selected.id} campaign={selected} status={status} outboundStopped={control?.stopped !== false} onChanged={reload} mode="setup" />}
            {!selected && <div className="cc-card p-10 text-center text-sm text-t3">Create a list from Existing patients or Appointment reminders, then return here for advanced settings and technical evidence.</div>}
          </div>
        </div>
      </div>}
    </div>
  );
}
