import { Star, CheckCircle2, AlertCircle, Sparkles, ArrowRight, TrendingUp, MessageSquare } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { reviews } from '../data/mockReviews';
import { branches, doctors } from '../data/mockClinics';

const avgRating = (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1);
const positiveCount = reviews.filter(r => r.sentiment === 'positive').length;
const negativeCount = reviews.filter(r => r.sentiment === 'negative').length;
const unrespondedNegative = reviews.filter(r => r.sentiment === 'negative' && !r.responded);
const sentimentPct = Math.round((positiveCount / reviews.length) * 100);
const ratingDist = [5, 4, 3, 2, 1].map(r => ({ star: r, count: reviews.filter(rv => rv.rating === r).length }));

export default function Reviews() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Reviews & Referrals"
        subtitle="Reputation management, review automation, negative feedback recovery, and referral tracking."
        badge={`${unrespondedNegative.length} Needs Response`}
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Launch Review Campaign
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Avg Rating" value={avgRating} subtitle="All platforms" trend={4} icon={<Star className="w-4 h-4" />} accent="amber" />
        <StatCard title="Total Reviews" value={reviews.length} subtitle="This month" icon={<MessageSquare className="w-4 h-4" />} accent="blue" />
        <StatCard title="Positive Sentiment" value={`${sentimentPct}%`} subtitle="Of all reviews" trend={6} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Unresolved Negative" value={negativeCount} subtitle="Needs recovery action" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <BentoCard title="Review Feed" subtitle="Latest reviews · All platforms">
            <div className="space-y-3">
              {reviews.map((r) => (
                <div key={r.id} className={`p-4 rounded-2xl border transition-all hover:shadow-sm ${
                  r.sentiment === 'negative' ? 'border-red-200 bg-red-50/40' :
                  r.sentiment === 'positive' ? 'border-emerald-100' : 'border-slate-200'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-slate-600 text-[10px] font-bold shrink-0">
                        {r.patientName.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-900">{r.patientName}</p>
                        <div className="flex items-center gap-1">
                          {[...Array(5)].map((_, i) => (
                            <Star key={i} className={`w-3 h-3 ${i < r.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-200 fill-slate-200'}`} />
                          ))}
                          <span className="text-[10px] text-slate-400 ml-1">{r.date}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.platform === 'google' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{r.platform}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.sentiment === 'positive' ? 'bg-emerald-100 text-emerald-700' : r.sentiment === 'negative' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{r.sentiment}</span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed mb-3">"{r.text}"</p>
                  {r.responded && r.aiDraftResponse && (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100 mb-2">
                      <p className="text-[10px] font-bold text-slate-400 mb-1">Response sent</p>
                      <p className="text-xs text-slate-600">{r.aiDraftResponse}</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {r.responded
                      ? <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> Responded</span>
                      : <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors"><Sparkles className="w-3 h-3" /> Draft AI Response</button>
                    }
                    {r.sentiment === 'negative' && !r.responded && (
                      <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:text-red-700"><AlertCircle className="w-3 h-3" /> Flag for manager</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          <BentoCard title="Rating Distribution" subtitle="All reviews combined">
            <div className="space-y-2.5">
              {ratingDist.map(({ star, count }) => (
                <div key={star} className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5 w-16 shrink-0">
                    {[...Array(star)].map((_, i) => <Star key={i} className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />)}
                  </div>
                  <div className="flex-1"><ProgressBar value={count} max={reviews.length} color={star >= 4 ? 'emerald' : star === 3 ? 'amber' : 'red'} /></div>
                  <span className="text-xs font-bold text-slate-700 w-4 text-right shrink-0">{count}</span>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Branch Reputation" subtitle="Avg rating by location">
            <div className="space-y-2.5">
              {branches.map((b) => {
                const br = reviews.filter(r => r.branchId === b.id);
                const avg = br.length > 0 ? (br.reduce((s, r) => s + r.rating, 0) / br.length).toFixed(1) : 'N/A';
                const score = parseFloat(avg);
                return (
                  <div key={b.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                    <div>
                      <p className="text-xs font-bold text-slate-900">{b.name.split(' ')[0]}</p>
                      <p className="text-[10px] text-slate-400">{br.length} reviews</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                      <span className={`text-sm font-bold ${score >= 4.5 ? 'text-emerald-700' : score >= 4 ? 'text-amber-600' : 'text-red-600'}`}>{avg}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          <BentoCard title="Top Provider Ratings" subtitle="By review score">
            <div className="space-y-2.5">
              {[...doctors].sort((a, b) => b.rating - a.rating).slice(0, 5).map((doc) => (
                <div key={doc.id} className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-slate-800 truncate">{doc.name}</p>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span className="text-xs font-bold text-slate-900">{doc.rating}</span>
                    <span className="text-[10px] text-slate-400">({doc.reviewCount})</span>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          <div className="rounded-2xl bg-gradient-to-br from-violet-600 to-blue-600 p-4 text-white shadow-lg shadow-violet-500/20">
            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-200 mb-2">Referral Programme</p>
            <p className="text-2xl font-bold mb-1">18 referrals</p>
            <p className="text-xs text-violet-200 mb-3">Generated this month · £6,400 attributed revenue</p>
            <button type="button" className="w-full py-2 rounded-xl bg-white/20 hover:bg-white/30 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> Launch referral campaign
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
