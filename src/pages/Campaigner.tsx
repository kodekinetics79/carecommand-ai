import { useState } from 'react';
import { Sparkles, Zap, ArrowRight, Target, Users, TrendingUp, CheckCircle2, Play, PauseCircle } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ModuleTabs from '../components/ui/ModuleTabs';
import ProgressBar from '../components/ui/ProgressBar';
import { campaigns } from '../data/mockCampaigns';

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  active:    { label: 'Active',     color: 'text-emerald-700', bg: 'bg-emerald-100' },
  scheduled: { label: 'Scheduled', color: 'text-blue-700',    bg: 'bg-blue-100' },
  draft:     { label: 'Draft',      color: 'text-slate-600',  bg: 'bg-slate-100' },
  paused:    { label: 'Paused',     color: 'text-amber-700',  bg: 'bg-amber-100' },
  completed: { label: 'Completed', color: 'text-teal-700',    bg: 'bg-teal-100' },
};

const goalCards = [
  { id: 'winback', icon: <Users className="w-5 h-5" />, title: 'Reactivate Inactive Customers', desc: 'Target 30–180 day inactive segment', est: '£18,700', color: 'border-blue-200 bg-blue-50', iconBg: 'bg-blue-100 text-blue-700' },
  { id: 'slots', icon: <Target className="w-5 h-5" />, title: 'Fill Empty Appointment Slots', desc: 'Boost branch utilisation with targeted offers', est: '£6,200', color: 'border-violet-200 bg-violet-50', iconBg: 'bg-violet-100 text-violet-700' },
  { id: 'reviews', icon: <CheckCircle2 className="w-5 h-5" />, title: 'Grow Reputation & Reviews', desc: 'Post-visit review request automation', est: '28 reviews', color: 'border-amber-200 bg-amber-50', iconBg: 'bg-amber-100 text-amber-700' },
  { id: 'referrals', icon: <TrendingUp className="w-5 h-5" />, title: 'Drive Referral Revenue', desc: 'Loyalty and referral reward program', est: '£4,500', color: 'border-emerald-200 bg-emerald-50', iconBg: 'bg-emerald-100 text-emerald-700' },
];

const messagePreviews: Record<string, string> = {
  whatsapp: "👋 Hi {Name}, it's been a while! We miss you at CareCommand Clinics.\n\nWe've saved a slot just for you this week: *Wednesday 28 May at 10:30am*.\n\nReply YES to confirm or tap to rebook: 🔗 [Book Now]\n\n_Reply STOP to opt out._",
  sms: "Hi {Name}, you have a special slot waiting at CareCommand Clinics. Book your appointment: bit.ly/carecommand-book. Reply STOP to opt out.",
  email: "Subject: We've saved a slot for you, {Name}!\n\nHi {Name},\n\nIt's been a while since your last visit, and we'd love to welcome you back.\n\nOur team at [Branch Name] has availability this week, and we've put together a special offer just for returning customers.\n\n[Book Your Appointment →]\n\nWarm regards,\nThe CareCommand AI Team",
  push: "📅 Your slot is waiting! Tap to book your appointment this week at CareCommand Clinics.",
};

const channelTabs = [
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'sms', label: 'SMS' },
  { id: 'email', label: 'Email' },
  { id: 'push', label: 'Push' },
];

const campaignFilterTabs = [
  { id: 'all', label: 'All', count: campaigns.length },
  { id: 'active', label: 'Active', count: campaigns.filter(c => c.status === 'active').length },
  { id: 'draft', label: 'Draft', count: campaigns.filter(c => c.status === 'draft').length },
  { id: 'completed', label: 'Completed', count: campaigns.filter(c => c.status === 'completed').length },
];

const totalRevenue = campaigns.reduce((s, c) => s + c.revenue, 0);
const totalBooked = campaigns.reduce((s, c) => s + c.booked, 0);
const activeCount = campaigns.filter(c => c.status === 'active').length;

export default function Campaigner() {
  const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
  const [previewChannel, setPreviewChannel] = useState('whatsapp');
  const [campaignFilter, setCampaignFilter] = useState('all');

  const filteredCampaigns = campaignFilter === 'all' ? campaigns : campaigns.filter(c => c.status === campaignFilter);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Campaigner"
        subtitle="AI-powered campaign studio — build, launch, and measure multi-channel growth campaigns."
        badge={`${activeCount} Active`}
        badgeColor="emerald"
        actions={
          <div className="flex gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:opacity-90 transition">
              <Sparkles className="w-4 h-4" /> Launch AI Campaign Wizard
            </button>
          </div>
        }
      />

      {/* KPIs */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Campaign Revenue" value={`£${totalRevenue.toLocaleString()}`} subtitle="All campaigns" trend={18} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Total Bookings" value={totalBooked} subtitle="From campaigns" trend={12} icon={<CheckCircle2 className="w-4 h-4" />} accent="blue" />
        <StatCard title="Active Campaigns" value={activeCount} subtitle="Currently running" icon={<Play className="w-4 h-4" />} accent="violet" />
        <StatCard title="Avg Conversion Rate" value="19.4%" subtitle="Across all campaigns" trend={3} icon={<Target className="w-4 h-4" />} accent="cyan" />
      </div>

      {/* Goal Selector */}
      <BentoCard title="AI Campaign Goal Selector" subtitle="Choose a campaign objective" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {goalCards.map((goal) => (
            <button
              key={goal.id}
              type="button"
              onClick={() => setSelectedGoal(selectedGoal === goal.id ? null : goal.id)}
              className={`relative text-left p-4 rounded-2xl border-2 transition-all hover:shadow-md ${
                selectedGoal === goal.id ? 'border-blue-500 bg-blue-50 shadow-md shadow-blue-500/10' : `border ${goal.color}`
              }`}
            >
              {selectedGoal === goal.id && (
                <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                  <CheckCircle2 className="w-3 h-3 text-white" />
                </div>
              )}
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${goal.iconBg}`}>{goal.icon}</div>
              <p className="text-sm font-bold text-slate-900 leading-tight mb-1">{goal.title}</p>
              <p className="text-[11px] text-slate-500 mb-2">{goal.desc}</p>
              <p className="text-sm font-bold text-emerald-700">Est. {goal.est}</p>
            </button>
          ))}
        </div>
        {selectedGoal && (
          <div className="mt-4 p-4 rounded-2xl bg-gradient-to-r from-blue-50 to-violet-50 border border-blue-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-900">AI has built your campaign segments</p>
                <p className="text-xs text-slate-500 mt-0.5">Audience identified · Message optimised · Best send time set</p>
              </div>
              <button type="button" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors shadow-md shadow-blue-500/20 shrink-0">
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
                  <div key={c.id} className="p-4 rounded-2xl border border-slate-200 hover:border-blue-200 hover:shadow-sm transition-all">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-start gap-3">
                        <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${c.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-bold text-slate-900">{c.name}</p>
                            {c.aiGenerated && <span className="text-[10px] font-bold text-violet-700 bg-violet-50 px-2 py-0.5 rounded-full">AI</span>}
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">{c.goal}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg} ${sc.color}`}>{sc.label}</span>
                        {c.revenue > 0 && <span className="text-xs font-bold text-emerald-700">£{c.revenue.toLocaleString()}</span>}
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-2 mb-3">
                      <div className="text-center p-2 rounded-lg bg-slate-50">
                        <p className="text-sm font-bold text-slate-900">{c.audienceSize}</p>
                        <p className="text-[10px] text-slate-400">Audience</p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-slate-50">
                        <p className="text-sm font-bold text-slate-900">{c.sent > 0 ? `${openRate}%` : '—'}</p>
                        <p className="text-[10px] text-slate-400">Open Rate</p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-slate-50">
                        <p className="text-sm font-bold text-emerald-700">{c.sent > 0 ? `${convRate}%` : '—'}</p>
                        <p className="text-[10px] text-slate-400">Conversion</p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-slate-50">
                        <p className="text-sm font-bold text-slate-900">{c.booked}</p>
                        <p className="text-[10px] text-slate-400">Booked</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      {c.channels.map(ch => (
                        <span key={ch} className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full capitalize">{ch}</span>
                      ))}
                    </div>

                    {c.sent > 0 && <ProgressBar value={convRate} color={convRate >= 20 ? 'emerald' : convRate >= 10 ? 'amber' : 'red'} />}

                    <div className="flex items-center gap-2 mt-3">
                      {c.status === 'active' && (
                        <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 hover:text-amber-700">
                          <PauseCircle className="w-3.5 h-3.5" /> Pause
                        </button>
                      )}
                      {(c.status === 'draft' || c.status === 'scheduled') && (
                        <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
                          <Play className="w-3.5 h-3.5" /> Launch
                        </button>
                      )}
                      <button type="button" className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700">
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
              previewChannel === 'whatsapp' ? 'bg-emerald-50 border border-emerald-200 text-emerald-900 font-[system-ui]' :
              previewChannel === 'sms' ? 'bg-slate-50 border border-slate-200 text-slate-800' :
              previewChannel === 'email' ? 'bg-blue-50 border border-blue-200 text-blue-900 font-mono text-xs' :
              'bg-violet-50 border border-violet-200 text-violet-900'
            }`}>
              {messagePreviews[previewChannel]}
            </div>
            <div className="flex items-center gap-2 mt-3">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <p className="text-[11px] text-slate-500">Consent check: <span className="font-semibold text-emerald-700">Active · opt-out link included</span></p>
            </div>
          </BentoCard>

          {/* Audience preview */}
          <BentoCard title="Audience Builder" subtitle="AI-segmented audience">
            <div className="space-y-2.5">
              {[
                { label: 'Inactive 60–90 days', count: 87, pct: 47, color: 'bg-blue-500' },
                { label: 'At-risk lifecycle stage', count: 54, pct: 29, color: 'bg-amber-500' },
                { label: 'High LTV, low engagement', count: 31, pct: 17, color: 'bg-violet-500' },
                { label: 'Excluded: no consent', count: 15, pct: 8, color: 'bg-slate-300' },
              ].map((seg) => (
                <div key={seg.label}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${seg.color}`} />
                      <p className="text-xs font-medium text-slate-700">{seg.label}</p>
                    </div>
                    <span className="text-xs font-bold text-slate-900">{seg.count}</span>
                  </div>
                  <ProgressBar value={seg.pct} color={seg.color === 'bg-blue-500' ? 'blue' : seg.color === 'bg-amber-500' ? 'amber' : seg.color === 'bg-violet-500' ? 'violet' : 'blue'} />
                </div>
              ))}
            </div>
            <div className="mt-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs font-bold text-slate-900">187 customers in final audience</p>
              <p className="text-[11px] text-slate-500 mt-0.5">15 excluded for no consent · WhatsApp preferred: 124</p>
            </div>
          </BentoCard>

          {/* ROI estimate */}
          <div className="rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-600 p-4 text-white shadow-lg shadow-emerald-500/20">
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-200 mb-2">Estimated Campaign ROI</p>
            <p className="text-3xl font-bold mb-0.5">£18,700</p>
            <p className="text-xs text-emerald-200 mb-3">Based on 18% historical conversion · 187 audience</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-white/10 rounded-xl p-2">
                <p className="text-sm font-bold">34</p>
                <p className="text-[10px] text-emerald-200">Est. bookings</p>
              </div>
              <div className="bg-white/10 rounded-xl p-2">
                <p className="text-sm font-bold">£550</p>
                <p className="text-[10px] text-emerald-200">Avg value</p>
              </div>
              <div className="bg-white/10 rounded-xl p-2">
                <p className="text-sm font-bold">6.2×</p>
                <p className="text-[10px] text-emerald-200">Est. ROI</p>
              </div>
            </div>
            <button type="button" className="mt-3 w-full py-2 rounded-xl bg-white/20 hover:bg-white/30 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
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
                  <p className="text-xs text-slate-600">{g.label}</p>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
