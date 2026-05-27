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
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
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
                <div key={r.id} className={`p-4 rounded-2xl border transition-all hover:bg-[var(--s3)] ${
                  r.sentiment === 'negative' ? 'border-[var(--b2)] bg-[var(--red-soft)]' :
                  r.sentiment === 'positive' ? 'border-[var(--b1)]' : 'border-[var(--b1)]'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-[var(--s3)] flex items-center justify-center text-t2 text-[10px] font-bold shrink-0">
                        {r.patientName.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-t1">{r.patientName}</p>
                        <div className="flex items-center gap-1">
                          {[...Array(5)].map((_, i) => (
                            <Star key={i} className={`w-3 h-3 ${i < r.rating ? 'fill-amber-400 text-amber-400' : 'text-t3 fill-[var(--s3)]'}`} />
                          ))}
                          <span className="text-[10px] text-t3 ml-1">{r.date}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`badge ${r.platform === 'google' ? 'badge-blue' : 'badge-blue'}`}>{r.platform}</span>
                      <span className={`badge ${r.sentiment === 'positive' ? 'badge-emerald' : r.sentiment === 'negative' ? 'badge-red' : 'badge-blue'}`}>{r.sentiment}</span>
                    </div>
                  </div>
                  <p className="text-xs text-t2 leading-relaxed mb-3">"{r.text}"</p>
                  {r.responded && r.aiDraftResponse && (
                    <div className="p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--b1)] mb-2">
                      <p className="text-[10px] font-bold text-t3 mb-1">Response sent</p>
                      <p className="text-xs text-t2">{r.aiDraftResponse}</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {r.responded
                      ? <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-v"><CheckCircle2 className="w-3 h-3" /> Responded</span>
                      : <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo bg-[var(--indigo-soft)] px-3 py-1.5 rounded-lg hover:opacity-80 transition-colors"><Sparkles className="w-3 h-3" /> Draft AI Response</button>
                    }
                    {r.sentiment === 'negative' && !r.responded && (
                      <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-red-v hover:opacity-80"><AlertCircle className="w-3 h-3" /> Flag for manager</button>
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
                  <span className="text-xs font-bold text-t2 w-4 text-right shrink-0">{count}</span>
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
                  <div key={b.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                    <div>
                      <p className="text-xs font-bold text-t1">{b.name.split(' ')[0]}</p>
                      <p className="text-[10px] text-t3">{br.length} reviews</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                      <span className={`text-sm font-bold ${score >= 4.5 ? 'text-emerald-v' : score >= 4 ? 'text-amber-v' : 'text-red-v'}`}>{avg}</span>
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
                  <p className="text-xs font-semibold text-t1 truncate">{doc.name}</p>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span className="text-xs font-bold text-t1">{doc.rating}</span>
                    <span className="text-[10px] text-t3">({doc.reviewCount})</span>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          <div className="rounded-2xl bg-[var(--s2)] border border-[var(--b1)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-v mb-2">Referral Programme</p>
            <p className="text-2xl font-bold text-t1 mb-1">18 referrals</p>
            <p className="text-xs text-t2 mb-3">Generated this month · £6,400 attributed revenue</p>
            <button type="button" className="w-full py-2 rounded-xl bg-[var(--s3)] hover:bg-[var(--b1)] text-t1 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> Launch referral campaign
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
