import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Sparkles, Zap, ArrowRight, Target, Users, TrendingUp, CheckCircle2, Play, PauseCircle, AlertTriangle } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ModuleTabs from '../components/ui/ModuleTabs';
import ProgressBar from '../components/ui/ProgressBar';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapCampaign, type ApiCampaign } from '../lib/apiAdapters';
import { apiRequest } from '../lib/api';

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  active:    { label: 'Active',     color: 'text-emerald-700', bg: 'bg-emerald-100' },
  scheduled: { label: 'Scheduled', color: 'text-blue-700',    bg: 'bg-blue-100' },
  draft:     { label: 'Draft',      color: 'text-slate-600',  bg: 'bg-slate-100' },
  paused:    { label: 'Paused',     color: 'text-amber-700',  bg: 'bg-amber-100' },
  completed: { label: 'Completed', color: 'text-teal-700',    bg: 'bg-teal-100' },
};

const goalCards = [
  { id: 'winback', icon: <Users className="w-5 h-5" />, title: 'Reconnect with inactive patients', desc: 'Build a draft for an approved, consented segment', est: 'Requires audience review', color: 'border-[var(--b2)] bg-[var(--blue-soft)]', iconBg: 'bg-[var(--blue-soft)] text-blue-v' },
  { id: 'slots', icon: <Target className="w-5 h-5" />, title: 'Share appointment availability', desc: 'Offer current openings without implying a hold', est: 'Requires slot validation', color: 'border-[var(--b2)] bg-[var(--violet-soft)]', iconBg: 'bg-[var(--violet-soft)] text-violet-v' },
  { id: 'reviews', icon: <CheckCircle2 className="w-5 h-5" />, title: 'Request patient feedback', desc: 'Prepare an approved post-visit request', est: 'Requires eligibility review', color: 'border-[var(--b2)] bg-[var(--amber-soft)]', iconBg: 'bg-[var(--amber-soft)] text-amber-v' },
  { id: 'referrals', icon: <TrendingUp className="w-5 h-5" />, title: 'Prepare a referral campaign', desc: 'Create a draft under clinic and jurisdiction rules', est: 'Requires policy approval', color: 'border-[var(--b2)] bg-[var(--emerald-soft)]', iconBg: 'bg-[var(--emerald-soft)] text-emerald-v' },
];

const messagePreviews: Record<string, string> = {
  whatsapp: "Hi {Name}, this is [Clinic Name]. If you would like to schedule a visit, you can review current appointment options here: [Scheduling Link]. No appointment is held until booking is confirmed. Reply STOP to opt out.",
  sms: "[Clinic Name]: Review current appointment options at [Scheduling Link]. No appointment is held until confirmed. Reply STOP to opt out.",
  email: "Subject: Appointment options from [Clinic Name]\n\nHi {Name},\n\nIf you would like to schedule a visit, you can review current options at [Scheduling Link]. Availability can change, and no appointment is held until booking is confirmed.\n\nManage communication preferences: [Preferences Link]\n\n[Clinic Name]",
  push: "[Clinic Name] has appointment options available. Open scheduling to review; no appointment is held until confirmed.",
};

const channelTabs = [
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'sms', label: 'SMS' },
  { id: 'email', label: 'Email' },
  { id: 'push', label: 'Push' },
];

export default function Campaigner() {
  const navigate = useNavigate();
  const location = useLocation();
  const campaignContext = (location.state as { title?: string; branchName?: string; recommendedAction?: string } | null) ?? null;
  const [selectedGoal, setSelectedGoal] = useState<string | null>(campaignContext ? 'winback' : null);
  const [previewChannel, setPreviewChannel] = useState('whatsapp');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const { data: campaignRecords, source, error, reload } = useApiResource<ApiCampaign, ReturnType<typeof mapCampaign>>('/v1/campaigns?limit=100', [], mapCampaign);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const loadError = error;

  async function pauseCampaign(id: string) {
    setPendingId(id);
    try {
      await apiRequest(`/v1/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'PAUSED' }) });
      reload();
    } finally {
      setPendingId(null);
    }
  }

  function openApprovedCampaignWorkflow() {
    navigate('/reactivation', { state: selectedGoal ? { goal: selectedGoal } : undefined });
  }
  const campaignFilterTabs = [
    { id: 'all', label: 'All', count: campaignRecords.length },
    { id: 'active', label: 'Active', count: campaignRecords.filter(c => c.status === 'active').length },
    { id: 'draft', label: 'Draft', count: campaignRecords.filter(c => c.status === 'draft').length },
    { id: 'completed', label: 'Completed', count: campaignRecords.filter(c => c.status === 'completed').length },
  ];
  const totalRevenue = campaignRecords.reduce((sum, campaign) => sum + campaign.revenue, 0);
  const totalBooked = campaignRecords.reduce((sum, campaign) => sum + campaign.booked, 0);
  const totalSent = campaignRecords.reduce((sum, campaign) => sum + campaign.sent, 0);
  const recordedConversionRate = totalSent > 0 ? Math.round((totalBooked / totalSent) * 1000) / 10 : null;
  const activeCount = campaignRecords.filter(campaign => campaign.status === 'active').length;

  const filteredCampaigns = campaignFilter === 'all' ? campaignRecords : campaignRecords.filter(c => c.status === campaignFilter);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Campaign Planner & Portfolio"
        subtitle="Review stored campaign metrics and prepare content; approved audience and dispatch actions live in the Reactivation Engine."
        badge={loadError ? 'Data unavailable' : `${activeCount} Active · ${source === 'live' ? 'Stored campaign records' : 'Loading'}`}
        badgeColor={loadError ? 'red' : 'emerald'}
        actions={
          <div className="flex gap-2">
            <button type="button" onClick={() => { setSelectedGoal('winback'); window.scrollTo({ top: 320, behavior: 'smooth' }); }} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <Sparkles className="w-4 h-4" /> Open Campaign Wizard
            </button>
          </div>
        }
      />

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Campaign records could not be loaded from the clinic service: {loadError}
        </div>
      )}

      {/* KPIs */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Attributed Revenue" value={loadError ? 'Unavailable' : formatCurrency(totalRevenue)} subtitle={loadError ? 'Campaign records did not load' : 'Stored campaign attribution'} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Recorded Bookings" value={loadError ? 'Unavailable' : totalBooked} subtitle={loadError ? 'Campaign records did not load' : 'Stored campaign outcomes'} icon={<CheckCircle2 className="w-4 h-4" />} accent="blue" />
        <StatCard title="Active Campaigns" value={loadError ? 'Unavailable' : activeCount} subtitle={loadError ? 'Campaign records did not load' : 'Currently running'} icon={<Play className="w-4 h-4" />} accent="violet" />
        <StatCard title="Booking / Accepted" value={loadError ? 'Unavailable' : recordedConversionRate === null ? '—' : `${recordedConversionRate}%`} subtitle={loadError ? 'Campaign records did not load' : 'Bookings per provider-accepted request'} icon={<Target className="w-4 h-4" />} accent="cyan" />
      </div>

      {/* Goal Selector */}
      <BentoCard title="Campaign Goal Selector" subtitle="Choose a campaign objective" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
        {campaignContext && (
          <div className="mb-3 rounded-xl border border-[var(--b2)] bg-[var(--indigo-soft)] px-3 py-2 text-xs text-t1">
            <span className="font-semibold text-indigo">Context from ClinicRadar:</span>{' '}
            {campaignContext.title}{campaignContext.branchName ? ` · ${campaignContext.branchName}` : ''}{campaignContext.recommendedAction ? ` · ${campaignContext.recommendedAction}` : ''}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {goalCards.map((goal) => (
            <button
              key={goal.id}
              type="button"
              onClick={() => setSelectedGoal(selectedGoal === goal.id ? null : goal.id)}
              className={`relative text-left p-4 rounded-2xl border-2 transition-all hover:shadow-md ${
                selectedGoal === goal.id ? 'border-indigo bg-[var(--indigo-soft)] shadow-md shadow-[var(--indigo)]/10' : `border ${goal.color}`
              }`}
            >
              {selectedGoal === goal.id && (
                <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[var(--indigo)] flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-white" />
                </div>
              )}
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${goal.iconBg}`}>{goal.icon}</div>
              <p className="text-sm font-bold text-t1 leading-tight mb-1">{goal.title}</p>
              <p className="text-[11px] text-t3 mb-2">{goal.desc}</p>
              <p className="text-[11px] font-semibold text-amber-v">{goal.est}</p>
            </button>
          ))}
        </div>
        {selectedGoal && (
          <div className="mt-4 p-4 rounded-2xl bg-[var(--indigo-soft)] border border-[var(--b2)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-t1">Draft objective selected</p>
                <p className="text-xs text-t3 mt-0.5">Creating a draft does not authorize an audience, schedule delivery, or contact anyone.</p>
              </div>
              <button type="button" disabled={!selectedGoal} onClick={openApprovedCampaignWorkflow} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-colors shrink-0 disabled:opacity-40">
                <Zap className="w-3.5 h-3.5" /> Open approved campaign workflow
              </button>
            </div>
          </div>
        )}
      </BentoCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        {/* Campaign list */}
        <div className="space-y-4">
          <BentoCard
            title="Campaign Library"
            subtitle="All campaigns"
            headerRight={<ModuleTabs tabs={campaignFilterTabs} activeTab={campaignFilter} onChange={setCampaignFilter} />}
          >
            <div className="space-y-3">
              {filteredCampaigns.map((c) => {
                const sc = statusConfig[c.status] ?? statusConfig['draft'];
                const convRate = c.sent > 0 ? Math.round((c.booked / c.sent) * 100) : 0;
                const openRate = c.sent > 0 ? Math.round((c.opened / c.sent) * 100) : 0;
                return (
                  <div key={c.id} className="p-4 rounded-2xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-start gap-3">
                        <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${c.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-[var(--b2)]'}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-bold text-t1">{c.name}</p>
                            {c.aiGenerated && <span className="text-[10px] font-bold text-violet-v bg-[var(--violet-soft)] px-2 py-0.5 rounded-full">AI</span>}
                          </div>
                          <p className="text-xs text-t3 mt-0.5">{c.goal}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`badge ${
                          c.status === 'active' ? 'badge-emerald' :
                          c.status === 'scheduled' ? 'badge-blue' :
                          c.status === 'paused' ? 'badge-amber' :
                          c.status === 'completed' ? 'badge-cyan' :
                          'badge-blue'
                        }`}>{sc.label}</span>
                        {c.revenue > 0 && <span className="text-xs font-bold text-emerald-v">{formatCurrency(c.revenue)}</span>}
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-2 mb-3">
                      <div className="text-center p-2 rounded-lg bg-[var(--s3)]">
                        <p className="text-sm font-bold text-t1">{c.audienceSize}</p>
                        <p className="text-[10px] text-t3">Audience</p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-[var(--s3)]">
                        <p className="text-sm font-bold text-t1">{c.sent > 0 ? `${openRate}%` : '—'}</p>
                        <p className="text-[10px] text-t3">Open Rate</p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-[var(--s3)]">
                        <p className="text-sm font-bold text-emerald-v">{c.sent > 0 ? `${convRate}%` : '—'}</p>
                        <p className="text-[10px] text-t3">Booking / accepted</p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-[var(--s3)]">
                        <p className="text-sm font-bold text-t1">{c.booked}</p>
                        <p className="text-[10px] text-t3">Booked</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      {c.channels.map(ch => (
                        <span key={ch} className="badge badge-blue capitalize">{ch}</span>
                      ))}
                    </div>

                    {c.sent > 0 && <ProgressBar value={convRate} color={convRate >= 20 ? 'emerald' : convRate >= 10 ? 'amber' : 'red'} />}

                    <div className="flex items-center gap-2 mt-3">
                      {c.status === 'active' && (
                        <button type="button" disabled={pendingId === c.id} onClick={() => pauseCampaign(c.id)} className="inline-flex items-center gap-1 text-xs font-semibold text-amber-v hover:text-amber-v/80 disabled:opacity-40">
                          <PauseCircle className="w-3.5 h-3.5" /> {pendingId === c.id ? 'Pausing…' : 'Pause'}
                        </button>
                      )}
                      {(c.status === 'draft' || c.status === 'scheduled' || c.status === 'paused') && (
                        <button type="button" onClick={openApprovedCampaignWorkflow} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo hover:text-indigo/80">
                          <Play className="w-3.5 h-3.5" /> Open activation workflow
                        </button>
                      )}
                      <button type="button" onClick={() => navigate('/revenue')} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-t3 hover:text-t2">
                        View report <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>

        {/* Right: Message preview + consent */}
        <div className="space-y-4">
          <BentoCard title="Message Template Preview" subtitle="Draft examples only · clinic and counsel approval required">
            <div className="mb-4">
              <ModuleTabs tabs={channelTabs} activeTab={previewChannel} onChange={setPreviewChannel} />
            </div>
            <div className={`rounded-2xl p-4 text-sm leading-relaxed whitespace-pre-wrap min-h-[140px] ${
              previewChannel === 'whatsapp' ? 'bg-[var(--emerald-soft)] border border-[var(--b2)] text-emerald-v font-[system-ui]' :
              previewChannel === 'sms' ? 'bg-[var(--s3)] border border-[var(--b1)] text-t2' :
              previewChannel === 'email' ? 'bg-[var(--blue-soft)] border border-[var(--b2)] text-blue-v font-mono text-xs' :
              'bg-[var(--violet-soft)] border border-[var(--b2)] text-violet-v'
            }`}>
              {messagePreviews[previewChannel]}
            </div>
            <div className="flex items-center gap-2 mt-3">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <p className="text-[11px] text-t3">Template includes an opt-out instruction where shown. Recipient consent, suppression, channel eligibility, and jurisdiction rules are checked separately at activation and dispatch.</p>
            </div>
          </BentoCard>

          {/* Audience preview */}
          <BentoCard title="Audience Authorization" subtitle="No audience is inferred on this page">
            <div className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3">
              <p className="text-xs font-bold text-amber-v">Audience evidence required</p>
              <p className="mt-1 text-[11px] text-t3">Before activation, review purpose-specific consent, do-not-contact and suppression records, channel eligibility, jurisdiction, clinic policy, and the final recipient count. A CRM segment alone is not outreach authority.</p>
            </div>
          </BentoCard>

          {/* Planning state */}
          <div className="rounded-2xl bg-[var(--emerald-soft)] border border-[var(--b2)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-v mb-2">Planning inputs required</p>
            <p className="text-sm font-bold text-t1 mb-1">No ROI forecast is available</p>
            <p className="text-xs text-t3">Add approved audience, cost, attribution-window, expected-value, and historical conversion inputs before presenting a forecast. A forecast is not guaranteed revenue.</p>
            <button type="button" onClick={openApprovedCampaignWorkflow} className="mt-3 w-full py-2 rounded-xl bg-[var(--s2)] border border-[var(--b1)] hover:bg-[var(--s3)] text-t1 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Open approved campaign workflow
            </button>
          </div>

          {/* Safety panel */}
          <BentoCard title="Consent & Safety" subtitle="Activation requirements · not verified on this page">
            <div className="space-y-2">
              {[
                'Purpose-specific consent is current and source-attributed',
                'DNC, revocation, and suppression checks pass at dispatch',
                'Channel and jurisdiction requirements are approved',
                'Opt-out instructions and handling are tested',
                'Clinic reviewer approved the exact final content',
              ].map((g, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-v shrink-0" />
                  <p className="text-xs text-t2">{g}</p>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
