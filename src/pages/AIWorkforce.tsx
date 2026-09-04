import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarCheck2,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Construction,
  Megaphone,
  PhoneCall,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { ApiError } from '../lib/api';
import {
  aiWorkforceService,
  type PreparedConfirmationCampaign,
  type WorkforceCapabilityState,
  type WorkforceClinic,
  type WorkforceOverview,
} from '../lib/aiWorkforce';

function stateLabel(state: WorkforceCapabilityState) {
  if (state === 'ready') return 'Ready';
  if (state === 'needs_setup') return 'Needs setup';
  return 'Building';
}

function CapabilityBadge({ state }: { state: WorkforceCapabilityState }) {
  const cls = state === 'ready'
    ? 'badge badge-emerald'
    : state === 'needs_setup'
      ? 'badge badge-amber'
      : 'badge badge-indigo';
  const Icon = state === 'ready' ? CheckCircle2 : state === 'needs_setup' ? AlertTriangle : Construction;
  return <span className={cls}><Icon className="w-3 h-3" />{stateLabel(state)}</span>;
}

function WorkCard({
  icon,
  label,
  value,
  detail,
  onOpen,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  detail: string;
  onOpen?: () => void;
}) {
  const content = (
    <div className="cc-card p-4 h-full flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="stat-icon stat-icon-indigo">{icon}</div>
        <span className="text-2xl font-bold tracking-tight text-t1 tabular-nums">{value.toLocaleString()}</span>
      </div>
      <div>
        <p className="text-[13px] font-semibold text-t1">{label}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-t3">{detail}</p>
      </div>
      {onOpen && (
        <span className="mt-auto pt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-indigo">
          View details <ArrowRight className="w-3 h-3" />
        </span>
      )}
    </div>
  );
  if (!onOpen) return content;
  return <button type="button" onClick={onOpen} className="text-left h-full w-full">{content}</button>;
}

function reasonText(reason?: string) {
  if (!reason) return null;
  if (reason === 'unattended_dispatcher_not_yet_on_current_main') return 'Automatic outbound calling is being completed and certified.';
  if (reason === 'generic_survey_and_custom_form_runtime_is_next_increment') return 'Reusable surveys and custom forms are being completed and certified.';
  return reason.replace(/_/g, ' ');
}

export default function AIWorkforce() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<WorkforceOverview | null>(null);
  const [clinics, setClinics] = useState<WorkforceClinic[]>([]);
  const [selectedClinicId, setSelectedClinicId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<PreparedConfirmationCampaign | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextOverview, nextClinics] = await Promise.all([
        aiWorkforceService.overview(),
        aiWorkforceService.clinics(),
      ]);
      setOverview(nextOverview);
      const active = nextClinics.filter(clinic => clinic.active);
      setClinics(active);
      setSelectedClinicId(current => current && active.some(clinic => clinic.id === current)
        ? current
        : active[0]?.id ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI Workforce could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const capabilityRows = useMemo(() => overview ? [
    {
      label: 'Answer patient calls',
      description: `${overview.capabilities.inboundAiReceptionist.readyAgents} ready voice configuration${overview.capabilities.inboundAiReceptionist.readyAgents === 1 ? '' : 's'}`,
      state: overview.capabilities.inboundAiReceptionist.state,
    },
    {
      label: 'Book appointments during calls',
      description: `${overview.capabilities.liveAppointmentBooking.voiceBookableServices} bookable service${overview.capabilities.liveAppointmentBooking.voiceBookableServices === 1 ? '' : 's'} · ${overview.capabilities.liveAppointmentBooking.activeProviders} active provider${overview.capabilities.liveAppointmentBooking.activeProviders === 1 ? '' : 's'}`,
      state: overview.capabilities.liveAppointmentBooking.state,
    },
    {
      label: 'Make approved outbound calls',
      description: `${overview.capabilities.governedOutboundCalling.pendingTargets} patient${overview.capabilities.governedOutboundCalling.pendingTargets === 1 ? '' : 's'} waiting across outbound work`,
      state: overview.capabilities.governedOutboundCalling.state,
    },
    {
      label: 'Run outbound calling automatically',
      description: reasonText(overview.capabilities.autonomousOutboundDialer.reason) ?? 'Automatic voice operations',
      state: overview.capabilities.autonomousOutboundDialer.state,
    },
    {
      label: 'Complete patient intake',
      description: `${overview.capabilities.conversationalIntake.incompletePackets} incomplete intake packet${overview.capabilities.conversationalIntake.incompletePackets === 1 ? '' : 's'} currently visible`,
      state: overview.capabilities.conversationalIntake.state,
    },
    {
      label: 'Complete surveys and clinic forms',
      description: reasonText(overview.capabilities.universalConversationalForms.reason) ?? 'Reusable forms and surveys',
      state: overview.capabilities.universalConversationalForms.state,
    },
  ] : [], [overview]);

  async function prepareConfirmations() {
    if (!selectedClinicId || preparing) return;
    setPreparing(true);
    setPrepareError(null);
    setPrepared(null);
    try {
      const result = await aiWorkforceService.prepareAppointmentConfirmations({
        clinicId: selectedClinicId,
        horizonHours: 48,
        maxTargets: 250,
      });
      setPrepared(result);
      await load();
    } catch (cause) {
      const message = cause instanceof ApiError && cause.status === 409
        ? cause.message.replace(/_/g, ' ')
        : cause instanceof Error ? cause.message : 'The confirmation work could not be prepared.';
      setPrepareError(message);
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="animate-fade-up space-y-5">
      <PageHeader
        title="AI Workforce"
        subtitle="See what needs attention, let AI handle routine front-desk work, and review only the exceptions."
        badge="Front Office"
        badgeColor="violet"
        actions={(
          <button type="button" onClick={() => void load()} disabled={loading}
            className="workspace-btn inline-flex items-center gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        )}
      />

      {error && (
        <div className="rounded-xl border border-red-v/30 bg-red-v/5 px-4 py-3 text-[12px] text-red-v" role="alert">
          {error}
        </div>
      )}

      <section className="command-deck p-5 md:p-6">
        <div className="command-deck-grid" aria-hidden="true" />
        <div className="relative z-[1] grid gap-5 lg:grid-cols-[1.25fr_0.75fr] lg:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo/40 bg-white/70 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-indigo">
              <Sparkles className="w-3.5 h-3.5" /> Conversation → action → outcome
            </div>
            <h2 className="mt-4 max-w-3xl text-[24px] md:text-[30px] font-bold tracking-[-0.035em] text-t1 leading-[1.08]">
              AI handles routine front-office work. Your team handles exceptions.
            </h2>
            <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-t2">
              Calls, scheduling, patient intake and follow-up use the same live clinic records your staff already works with.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="deck-chip">
              <div className="deck-dot bg-emerald-v" />
              <div><p className="text-[10px] text-t3">Active clinics</p><p className="text-lg font-bold text-t1">{overview?.operations.activeBranches ?? '—'}</p></div>
            </div>
            <div className="deck-chip">
              <div className="deck-dot bg-indigo" />
              <div><p className="text-[10px] text-t3">Calls happening now</p><p className="text-lg font-bold text-t1">{overview?.workload.callsCurrentlyInProgress ?? '—'}</p></div>
            </div>
            <div className="deck-chip col-span-2">
              <ShieldCheck className="w-4 h-4 text-emerald-v" />
              <p className="text-[11px] leading-relaxed text-t2">CareCommand checks patient contact rules, clinic calling hours and safety limits automatically before any outbound call.</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-end justify-between gap-3 mb-3">
          <div>
            <h2 className="text-[15px] font-bold text-t1">Work waiting for AI</h2>
            <p className="mt-0.5 text-[11px] text-t3">Live counts from your clinic operations.</p>
          </div>
          {overview?.generatedAt && <span className="text-[10px] text-t3">Updated {new Date(overview.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <WorkCard icon={<CalendarCheck2 className="w-4 h-4" />} label="Appointments to confirm"
            value={overview?.workload.appointmentsNeedingConfirmationNext24h ?? 0}
            detail="Upcoming appointments without patient confirmation."
            onOpen={() => navigate('/scheduling')} />
          <WorkCard icon={<PhoneCall className="w-4 h-4" />} label="Calls needing follow-up"
            value={overview?.workload.missedOrEscalatedInboundCallsLast24h ?? 0}
            detail="Recent calls that need another attempt or staff attention."
            onOpen={() => navigate('/front-desk')} />
          <WorkCard icon={<ClipboardList className="w-4 h-4" />} label="Intake forms incomplete"
            value={overview?.workload.incompleteIntakePackets ?? 0}
            detail="Patient intake work still waiting for information or review."
            onOpen={() => navigate('/patient-intake')} />
          <WorkCard icon={<Clock3 className="w-4 h-4" />} label="Appointment requests"
            value={overview?.workload.appointmentRequestsNeedingReview ?? 0}
            detail="Appointment requests that still need information or staff review."
            onOpen={() => navigate('/front-desk')} />
          <WorkCard icon={<UserRoundCheck className="w-4 h-4" />} label="Needs staff attention"
            value={overview?.workload.receptionistTasksNeedingStaff ?? 0}
            detail="Exceptions where a team member still owns the next step."
            onOpen={() => navigate('/front-desk')} />
          <WorkCard icon={<Megaphone className="w-4 h-4" />} label="Patients waiting for an outbound call"
            value={overview?.workload.outboundTargetsWaiting ?? 0}
            detail="Patients already prepared for approved outbound work."
            onOpen={() => navigate('/receptionist-studio')} />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.12fr_0.88fr]">
        <div className="cc-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.1em] text-indigo">
                <Bot className="w-3.5 h-3.5" /> AI action
              </div>
              <h2 className="mt-2 text-[17px] font-bold text-t1">Confirm upcoming appointments</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-t3 max-w-xl">
                CareCommand finds upcoming unconfirmed appointments and prepares the exact patients and appointment details for AI follow-up. Nothing is called until the existing approval and safety checks are complete.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label className="block">
              <span className="block mb-1.5 text-[11px] font-semibold text-t2">Clinic</span>
              <select value={selectedClinicId} onChange={event => setSelectedClinicId(event.target.value)}
                className="w-full rounded-xl border border-[var(--b1)] bg-white px-3 py-2.5 text-[13px] text-t1 outline-none focus:border-indigo">
                {clinics.length === 0 && <option value="">No active clinic available</option>}
                {clinics.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void prepareConfirmations()} disabled={!selectedClinicId || preparing}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-indigo px-4 py-2.5 text-[12px] font-semibold text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
              {preparing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {preparing ? 'Preparing…' : 'Prepare confirmations'}
            </button>
          </div>

          {prepareError && <div className="mt-3 rounded-xl border border-red-v/30 bg-red-v/5 px-3 py-2.5 text-[11px] text-red-v" role="alert">{prepareError}</div>}

          {prepared && (
            <div className="mt-4 rounded-xl border border-emerald-v/30 bg-[#ECFDF5] p-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-v shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-t1">{prepared.targetsPrepared} appointment{prepared.targetsPrepared === 1 ? '' : 's'} ready for AI confirmation</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-t2">{prepared.clinicName}. Calls placed: {prepared.callsPlaced}. Review and approval are still required before calling begins.</p>
                  {(prepared.invalidPhoneSkipped > 0 || prepared.duplicateDestinationSkipped > 0) && (
                    <p className="mt-1 text-[10px] text-t3">Needs cleanup: {prepared.invalidPhoneSkipped} invalid phone · {prepared.duplicateDestinationSkipped} duplicate destination.</p>
                  )}
                  <button type="button" onClick={() => navigate('/receptionist-studio')}
                    className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold text-indigo">
                    Review calling work <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="cc-card p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-bold text-t1">AI Workforce readiness</h2>
              <p className="mt-0.5 text-[11px] text-t3">Only capabilities that have passed their readiness checks are marked ready.</p>
            </div>
            <ShieldCheck className="w-5 h-5 text-indigo" />
          </div>
          <div className="mt-4 divide-y divide-[var(--b1)]">
            {capabilityRows.map(row => (
              <div key={row.label} className="py-3 first:pt-0 last:pb-0 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-t1">{row.label}</p>
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-t3">{row.description}</p>
                </div>
                <CapabilityBadge state={row.state} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
