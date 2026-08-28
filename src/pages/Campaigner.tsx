import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sparkles, Zap, ArrowRight, Target, Users, TrendingUp, CheckCircle2, Play, PauseCircle } from 'lucide-react';
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
  { id: 'winback', icon: <Users className="w-5 h-5" />, title: 'Reactivate Inactive Customers', desc: 'Target 30–180 day inactive segment', est: formatCurrency(18700), color: 'border-[var(--b2)] bg-[var(--blue-soft)]', iconBg: 'bg-[var(--blue-soft)] text-blue-v' },
  { id: 'slots', icon: <Target className="w-5 h-5" />, title: 'Fill Empty Appointment Slots', desc: 'Boost branch utilisation with targeted offers', est: formatCurrency(6200), color: 'border-[var(--b2)] bg-[var(--violet-soft)]', iconBg: 'bg-[var(--violet-soft)] text-violet-v' },
  { id: 'reviews', icon: <CheckCircle2 className="w-5 h-5" />, title: 'Grow Reputation & Reviews', desc: 'Post-visit review request automation', est: '28 reviews', color: 'border-[var(--b2)] bg-[var(--amber-soft)]', iconBg: 'bg-[var(--amber-soft)] text-amber-v' },
  { id: 'referrals', icon: <TrendingUp className="w-5 h-5" />, title: 'Drive Referral Revenue', desc: 'Loyalty and referral reward program', est: formatCurrency(4500), color: 'border-[var(--b2)] bg-[var(--emerald-soft)]', iconBg: 'bg-[var(--emerald-soft)] text-emerald-v' },
];

const messagePreviews: Record<string, string> = {
  whatsapp: "👋 Hi {Name}, it's been a while! We miss you at CareCommand Clinics.\n\nWe've saved a slot just for you this week: *Wednesday 28 May at 10:30am*.\n\nReply YES to confirm or tap to rebook: 🔗 [Book Now]\n\n_Reply STOP to opt out._",
  sms: "Hi {Name}, you have a special slot waiting at CareCommand Clinics. Book your appointment: bit.ly/carecommand-book. Reply STOP to opt out.",
  email: "Subject: We've saved a slot for you, {Name}!\n\nHi {Name},\n\nIt's been a while since your last visit, and we'd love to welcome you back.\n\nOur team at [Branch Name] has availability this week, and we've put together a special offer just for returning customers.\n\n[Book Your Appointment →]\n\nWarm regards,\nThe CareCommand Team",
  push: "📅 Your slot is waiting! Tap to book your appointment this week at CareCommand Clinics.",
};

const channelTabs = [
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'sms', label: 'SMS' },
  { id: 'email', label: 'Email' },
  { id: 'push', label: 'Push' },
];

const launchPlans: Record<string, { name: string; goal: string; channels: string[] }> = {
  winback: { name: 'Winback Campaign', goal: 'Reactivation for inactive customers', channels: ['WHATSAPP', 'EMAIL', 'SMS'] },
  slots: { name: 'Slot Fill Campaign', goal: 'Boost branch utilisation with targeted offers', channels: ['WHATSAPP', 'SMS'] },
  reviews: { name: 'Review Growth Campaign', goal: 'Post-visit review request automation', channels: ['WHATSAPP', 'SMS', 'EMAIL'] },
  referrals: { name: 'Referral Growth Campaign', goal: 'Loyalty and referral reward program', channels: ['EMAIL', 'WHATSAPP'] },
};

export default function Campaigner() {
  const navigate = useNavigate();
  const location = useLocation();
  const campaignContext = (location.state as { title?: string; branchName?: string; recommendedAction?: string } | null) ?? null;
  const [selectedGoal, setSelectedGoal] = useState<string | null>(campaignContext ? 'winback' : null);
  const [previewChannel, setPreviewChannel] = useState('whatsapp');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const { data: campaignRecords, source, error, reload } = useApiResource<ApiCampaign, ReturnType<typeof mapCampaign>>('/v1/campaigns?limit=100', [], mapCampaign);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const loadError = error;

  async function setCampaignStatus(id: string, status: 'ACTIVE' | 'PAUSED') {
    setPendingId(id);
    try {
      await apiRequest(`/v1/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      reload();
    } finally {
      setPendingId(null);
    }
  }

  async function createCampaign(name: string, goal: string, channels: string[] = ['WHATSAPP', 'EMAIL']) {
    setCreatingCampaign(true);
    try {
      await apiRequest('/v1/campaigns', {
        method: 'POST',
        body: JSON.stringify({ name, goal, status: 'DRAFT', channels, aiGenerated: true }),
      });
      reload();
    } finally {
      setCreatingCampaign(false);
    }
  }

  async function launchSelectedGoal() {
    const goalId = selectedGoal && launchPlans[selectedGoal] ? selectedGoal : 'winback';
    const plan = launchPlans[goalId];
    await createCampaign(plan.name, plan.goal, plan.channels);
  }
  const campaignFilterTabs = [
    { id: 'all', label: 'All', count: campaignRecords.length },
    { id: 'active', label: 'Active', count: campaignRecords.filter(c => c.status === 'active').length },
    { id: 'draft', label: 'Draft', count: campaignRecords.filter(c => c.status === 'draft').length },
    { id: 'completed', label: 'Completed', count: campaignRecords.filter(c => c.status === 'completed').length },
  ];
  const totalRevenue = campaignRecords.reduce((sum, campaign) => sum + campaign.revenue, 0);
  const totalBooked = campaignRecords.reduce((sum, campaign) => sum + campaign.booked, 0);
  const activeCount = campaignRecords.filter(campaign => campaign.status === 'active').length;

  const filteredCampaigns = campaignFilter === 'all' ? campaignRecords : campaignRecords.filter(c => c.status === campaignFilter);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Campaigner"
        subtitle="Campaign studio — build, launch, and measure multi-channel growth campaigns."
        badge={loadError ? 'Live Data Error' : `${activeCount} Active · ${source === 'live' ? 'Live DB' : 'Loading'}`}
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
          Campaign data could not be loaded from the live API: {loadError}
        </div>
      )}

      {/* KPIs */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Campaign Revenue" value={formatCurrency(totalRevenue)} subtitle="All campaigns" trend={18} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Total Bookings" value={totalBooked} subtitle="From campaigns" trend={12} icon={<CheckCircle2 className="w-4 h-4" />} accent="blue" />
        <StatCard title="Active Campaigns" value={activeCount} subtitle="Currently running" icon={<Play className="w-4 h-4" />} accent="violet" />
        <StatCard title="Avg Conversion Rate" value="19.4%" subtitle="Across all campaigns" trend={3} icon={<Target className="w-4 h-4" />} accent="cyan" />
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
              <p className="text-sm font-bold text-emerald-v">Est. {goal.est}</p>
            </button>
          ))}
        </div>
        {selectedGoal && (
          <div className="mt-4 p-4 rounded-2xl bg-[var(--indigo-soft)] border border-[var(--b2)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-t1">Campaign segments are ready</p>
                <p className="text-xs text-t3 mt-0.5">Audience identified · Message prepared · Best send time set</p>
              </div>
              <button type="button" disabled={!selectedGoal || creatingCampaign} onClick={() => void launchSelectedGoal()} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-colors shrink-0 disabled:opacity-40">
                <Zap className="w-3.5 h-3.5" /> Continue to Launch
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
                const convRate = c.audienceSize > 0 ? Math.round((c.booked / c.audienceSize) * 100) : 0;
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
                        <p className="text-[10px] text-t3">Conversion</p>
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
                        <button type="button" disabled={pendingId === c.id} onClick={() => setCampaignStatus(c.id, 'PAUSED')} className="inline-flex items-center gap-1 text-xs font-semibold text-amber-v hover:text-amber-v/80 disabled:opacity-40">
                          <PauseCircle className="w-3.5 h-3.5" /> {pendingId === c.id ? 'Pausing…' : 'Pause'}
                        </button>
                      )}
                      {(c.status === 'draft' || c.status === 'scheduled' || c.status === 'paused') && (
                        <button type="button" disabled={pendingId === c.id} onClick={() => setCampaignStatus(c.id, 'ACTIVE')} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo hover:text-indigo/80 disabled:opacity-40">
                          <Play className="w-3.5 h-3.5" /> {pendingId === c.id ? 'Launching…' : c.status === 'paused' ? 'Resume' : 'Launch'}
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
          <BentoCard title="Message Preview" subtitle="Multi-channel preview">
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
              <p className="text-[11px] text-t3">Consent check: <span className="font-semibold text-emerald-v">Active · opt-out link included</span></p>
            </div>
          </BentoCard>

          {/* Audience preview */}
          <BentoCard title="Audience Builder" subtitle="Segmented audience">
            <div className="space-y-2.5">
              {[
                { label: 'Inactive 60–90 days', count: 87, pct: 47, color: 'bg-blue-500' },
                { label: 'At-risk lifecycle stage', count: 54, pct: 29, color: 'bg-amber-500' },
                { label: 'High LTV, low engagement', count: 31, pct: 17, color: 'bg-violet-500' },
                { label: 'Excluded: no consent', count: 15, pct: 8, color: 'bg-[var(--b2)]' },
              ].map((seg) => (
                <div key={seg.label}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${seg.color}`} />
                      <p className="text-xs font-medium text-t2">{seg.label}</p>
                    </div>
                    <span className="text-xs font-bold text-t1">{seg.count}</span>
                  </div>
                  <ProgressBar value={seg.pct} color={seg.color === 'bg-blue-500' ? 'blue' : seg.color === 'bg-amber-500' ? 'amber' : seg.color === 'bg-violet-500' ? 'violet' : 'blue'} />
                </div>
              ))}
            </div>
            <div className="mt-3 p-3 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
              <p className="text-xs font-bold text-t1">187 customers in final audience</p>
              <p className="text-[11px] text-t3 mt-0.5">15 excluded for no consent · WhatsApp preferred: 124</p>
            </div>
          </BentoCard>

          {/* ROI estimate */}
          <div className="rounded-2xl bg-[var(--emerald-soft)] border border-[var(--b2)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-v mb-2">Estimated Campaign ROI</p>
            <p className="text-3xl font-bold text-t1 mb-0.5">{formatCurrency(18700)}</p>
            <p className="text-xs text-t3 mb-3">Based on 18% historical conversion · 187 audience</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-[var(--s2)] border border-[var(--b1)] rounded-xl p-2">
                <p className="text-sm font-bold text-t1">34</p>
                <p className="text-[10px] text-t3">Est. bookings</p>
              </div>
              <div className="bg-[var(--s2)] border border-[var(--b1)] rounded-xl p-2">
                <p className="text-sm font-bold text-t1">{formatCurrency(550)}</p>
                <p className="text-[10px] text-t3">Avg value</p>
              </div>
              <div className="bg-[var(--s2)] border border-[var(--b1)] rounded-xl p-2">
                <p className="text-sm font-bold text-t1">6.2×</p>
                <p className="text-[10px] text-t3">Est. ROI</p>
              </div>
            </div>
            <button type="button" onClick={() => void launchSelectedGoal()} className="mt-3 w-full py-2 rounded-xl bg-[var(--s2)] border border-[var(--b1)] hover:bg-[var(--s3)] text-t1 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Launch Campaign Now
            </button>
          </div>

          {/* Safety panel */}
          <BentoCard title="Consent & Safety" subtitle="Compliance guardrails">
            <div className="space-y-2">
              {[
                { label: 'SMS consent verified', ok: true },
                { label: 'WhatsApp opt-in confirmed', ok: true },
                { label: 'Marketing consent active', ok: true },
                { label: 'Opt-out link in all messages', ok: true },
                { label: 'No clinical claims in content', ok: true },
              ].map((g, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  <p className="text-xs text-t2">{g.label}</p>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
