import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Star, CheckCircle2, Sparkles, ArrowRight, TrendingUp, MessageSquare, ShieldCheck, BellRing } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { useApiResource } from '../hooks/useApiResource';
import { mapProviderProfile, mapReview, type ApiProviderProfile, type ApiReview } from '../lib/apiAdapters';
import { apiRequest } from '../lib/api';

interface ApiReputationCase {
  id: string;
  branchId: string;
  branch: { name: string };
  patient?: { firstName: string; lastName: string } | null;
  badReviewRisk: number;
  complaintCategory: string;
  unresolvedComplaint: string;
  workflowStatus: string;
  recoveryWorkflow: string;
  suggestedReply: string;
  npsScore: number;
  publicTrend: string;
  staffComplaintDetected: boolean;
  createdAt: string;
}

interface ApiReviewRequest {
  id: string;
  branchId: string;
  branch: { name: string };
  patient?: { firstName: string; lastName: string } | null;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO';
  requestType: string;
  status: string;
  message: string;
  sentAt?: string | null;
  respondedAt?: string | null;
  ratingReceived?: number | null;
}

interface ReputationResponse {
  summary: {
    unresolvedCases: number;
    avgBadReviewRisk: number;
    avgNpsScore: number;
    pendingReviewRequests: number;
  };
  cases: ApiReputationCase[];
  reviewRequests: ApiReviewRequest[];
}

export default function Reviews() {
  const navigate = useNavigate();
  const { data: reviewRecords, source, error: reviewError, reload } = useApiResource<ApiReview, ReturnType<typeof mapReview>>('/v1/reviews?limit=100', [], mapReview);
  const { data: branchOptions, error: branchError } = useApiResource<{ id: string; name: string }, { id: string; name: string }>('/v1/branches?limit=100', [], row => row);
  const { data: providerRecords, error: providerError } = useApiResource<ApiProviderProfile, ReturnType<typeof mapProviderProfile>>('/v1/providers/overview?limit=100', [], mapProviderProfile);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [responseNotice, setResponseNotice] = useState<{ id: string; kind: 'ok' | 'error'; text: string } | null>(null);

  async function respondToReview(id: string, draft?: string) {
    setRespondingId(id);
    setResponseNotice(null);
    try {
      await apiRequest(`/v1/reviews/${id}/respond`, {
        method: 'PATCH',
        body: JSON.stringify({ response: draft?.trim() || 'Thank you so much for taking the time to share your feedback — we truly appreciate it.' }),
      });
      reload();
      setResponseNotice({ id, kind: 'ok', text: 'Response recorded in CareCommand. External delivery is not confirmed here.' });
    } catch (error) {
      setResponseNotice({ id, kind: 'error', text: error instanceof Error ? error.message : 'Unable to record response' });
    } finally {
      setRespondingId(null);
    }
  }
  const [reputation, setReputation] = useState<ReputationResponse>({
    summary: { unresolvedCases: 0, avgBadReviewRisk: 0, avgNpsScore: 0, pendingReviewRequests: 0 },
    cases: [],
    reviewRequests: [],
  });
  const [reputationSource, setReputationSource] = useState<'loaded' | 'loading'>('loading');
  const [reputationError, setReputationError] = useState<string | null>(null);
  const avgRating = reviewRecords.length > 0 ? (reviewRecords.reduce((sum, review) => sum + review.rating, 0) / reviewRecords.length).toFixed(1) : '0.0';
  const positiveCount = reviewRecords.filter(review => review.sentiment === 'positive').length;
  const sentimentPct = reviewRecords.length > 0 ? Math.round((positiveCount / reviewRecords.length) * 100) : 0;
  const ratingDist = [5, 4, 3, 2, 1].map(rating => ({ star: rating, count: reviewRecords.filter(review => review.rating === rating).length }));

  useEffect(() => {
    let active = true;
    apiRequest<ReputationResponse>('/v1/reputation?limit=10')
      .then(row => {
        if (!active) return;
        setReputation(row);
        setReputationSource('loaded');
        setReputationError(null);
      })
      .catch(error => {
        if (!active) return;
        setReputationError(error instanceof Error ? error.message : 'Unable to load reputation data');
      });
    return () => { active = false; };
  }, []);

  const loadError = reviewError || branchError || providerError || reputationError;
  const reviewMetricsReady = source === 'live' && !reviewError;
  const reputationMetricsReady = reputationSource === 'loaded' && !reputationError;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Reviews & Referrals"
        subtitle="Review feedback, record responses, and open campaign setup for reputation and referral work."
        badge={loadError ? 'Data unavailable' : source !== 'live' || reputationSource === 'loading' ? 'Loading reviews' : `${reputation.summary.unresolvedCases} need review`}
        badgeColor={loadError ? 'red' : source !== 'live' || reputationSource === 'loading' ? 'blue' : reputation.summary.unresolvedCases > 0 ? 'amber' : 'emerald'}
        actions={
          <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Review campaign setup
          </button>
        }
      />

      {loadError && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Review data is unavailable. {loadError}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Average rating" value={reviewMetricsReady ? avgRating : '—'} subtitle={reviewMetricsReady ? 'Loaded reviews' : 'Unavailable'} icon={<Star className="w-4 h-4" />} accent="amber" />
        <StatCard title="Reviews loaded" value={reviewMetricsReady ? reviewRecords.length : '—'} subtitle={reviewMetricsReady ? 'Current result set' : 'Unavailable'} icon={<MessageSquare className="w-4 h-4" />} accent="blue" />
        <StatCard title="Positive sentiment" value={reviewMetricsReady ? `${sentimentPct}%` : '—'} subtitle={reviewMetricsReady ? 'Loaded reviews' : 'Unavailable'} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Review-risk score" value={reputationMetricsReady ? `${reputation.summary.avgBadReviewRisk}%` : '—'} subtitle={reputationMetricsReady ? 'Stored reputation cases · planning metric' : 'Unavailable'} icon={<ShieldCheck className="w-4 h-4" />} accent="red" />
        <StatCard title="Pending requests" value={reputationMetricsReady ? reputation.summary.pendingReviewRequests : '—'} subtitle={reputationMetricsReady ? 'Recorded request status' : 'Unavailable'} icon={<BellRing className="w-4 h-4" />} accent="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <BentoCard title="Review feed" subtitle="Latest loaded reviews across platforms">
            <div className="space-y-3">
              {reviewRecords.map((r) => (
                <div key={r.id} className={`p-4 rounded-2xl border transition-all hover:bg-[var(--s3)] ${
                  r.sentiment === 'negative' ? 'border-[var(--b2)] bg-[var(--red-soft)]' :
                  r.sentiment === 'positive' ? 'border-[var(--b1)]' : 'border-[var(--b1)]'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-[var(--s3)] flex items-center justify-center text-t2 text-[10px] font-bold shrink-0" aria-hidden="true">
                        {r.patientName === 'Reviewer name unavailable' ? '—' : r.patientName.split(' ').map(n => n[0]).join('')}
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
                      <p className="text-[10px] font-bold text-t3 mb-1">Response recorded</p>
                      <p className="text-xs text-t2">{r.aiDraftResponse}</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {r.responded
                      ? <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-v"><CheckCircle2 className="w-3 h-3" /> Responded</span>
                      : <button type="button" disabled={respondingId === r.id} onClick={() => void respondToReview(r.id, r.aiDraftResponse)} className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo bg-[var(--indigo-soft)] px-3 py-1.5 rounded-lg hover:opacity-80 transition-colors disabled:opacity-40"><Sparkles className="w-3 h-3" /> {respondingId === r.id ? 'Recording…' : r.aiDraftResponse ? 'Record drafted response' : 'Record standard response'}</button>
                    }
                  </div>
                  {responseNotice?.id === r.id && <p role={responseNotice.kind === 'error' ? 'alert' : 'status'} className={`mt-2 text-[11px] ${responseNotice.kind === 'error' ? 'text-red-v' : 'text-emerald-v'}`}>{responseNotice.text}</p>}
                </div>
              ))}
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          <BentoCard title="Reputation follow-up" subtitle="Unresolved cases and recorded recovery guidance" headerRight={
          <span className={`badge ${reputationSource === 'loaded' ? 'badge-blue' : 'badge-blue'}`}>{reputationSource === 'loaded' ? 'Data loaded' : 'Loading'}</span>
          }>
            <div className="space-y-3">
              {reputation.cases.map((item) => (
                <div key={item.id} className={`rounded-xl border border-[var(--b1)] p-3 ${item.staffComplaintDetected ? 'bg-[var(--red-soft)]' : 'bg-[var(--s2)]'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-t1">{item.branch.name}</p>
                      <p className="text-[10px] text-t3 mt-0.5">{item.complaintCategory} · {item.workflowStatus}</p>
                    </div>
                    <span className="badge badge-red">{item.badReviewRisk}% risk</span>
                  </div>
                  <p className="text-xs text-t2 mt-2 leading-relaxed">{item.unresolvedComplaint}</p>
                  <p className="text-[11px] text-t3 mt-2">Trend: {item.publicTrend} · NPS {item.npsScore}{item.staffComplaintDetected ? ' · staff issue detected' : ''}</p>
                  <p className="text-[11px] text-indigo mt-2 font-semibold">{item.recoveryWorkflow}</p>
                  <div className="mt-2 p-2.5 rounded-lg bg-[var(--s3)] border border-[var(--b1)]">
                    <p className="text-[10px] font-bold text-t3 mb-1">Suggested message · review before use</p>
                    <p className="text-xs text-t2">{item.suggestedReply}</p>
                  </div>
                </div>
              ))}
              {reputation.cases.length === 0 && (
                <p className="text-xs text-t3">{reputationMetricsReady ? 'No reputation cases are recorded for this clinic.' : 'Reputation cases are unavailable.'}</p>
              )}
            </div>
          </BentoCard>

          <BentoCard title="Review requests" subtitle="Recorded request and response status">
            <div className="space-y-2.5">
              {reputation.reviewRequests.map((request) => (
                <div key={request.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)]">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-t1">{request.requestType}</p>
                    <p className="text-[10px] text-t3 mt-0.5">{request.branch.name} · {request.channel.toLowerCase()} · {request.status}</p>
                    <p className="text-[11px] text-t2 mt-2">{request.message}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-bold text-t1">{request.ratingReceived ? `${request.ratingReceived}★` : '—'}</p>
                    <p className="text-[10px] text-t3">{request.respondedAt ? 'Responded' : 'Waiting'}</p>
                  </div>
                </div>
              ))}
              {reputation.reviewRequests.length === 0 && (
                <p className="text-xs text-t3">No review requests are recorded yet.</p>
              )}
            </div>
          </BentoCard>

          <BentoCard title="Rating Distribution" subtitle="All reviews combined">
            <div className="space-y-2.5">
              {ratingDist.map(({ star, count }) => (
                <div key={star} className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5 w-16 shrink-0">
                    {[...Array(star)].map((_, i) => <Star key={i} className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />)}
                  </div>
                  <div className="flex-1"><ProgressBar value={count} max={reviewRecords.length} color={star >= 4 ? 'emerald' : star === 3 ? 'amber' : 'red'} /></div>
                  <span className="text-xs font-bold text-t2 w-4 text-right shrink-0">{count}</span>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Branch Reputation" subtitle="Avg rating by location">
            <div className="space-y-2.5">
              {branchOptions.map((b) => {
                const br = reviewRecords.filter(r => r.branchId === b.id);
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
              {[...providerRecords].sort((a, b) => b.rating - a.rating).slice(0, 5).map((doc) => (
                <div key={doc.id} className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-t1 truncate">{doc.name}</p>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span className="text-xs font-bold text-t1">{doc.rating}</span>
                    <span className="text-[10px] text-t3">({doc.reviewCount})</span>
                  </div>
                </div>
              ))}
              {providerRecords.length === 0 && <p className="text-xs text-t3">No provider ratings are available.</p>}
            </div>
          </BentoCard>

          <div className="rounded-2xl bg-[var(--s2)] border border-[var(--b1)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-v mb-2">Referral campaigns</p>
            <p className="text-sm font-bold text-t1 mb-1">Set up a governed referral workflow</p>
            <p className="text-xs text-t2 mb-3">Open campaign setup to review audience, consent, message, and approval requirements. No referral results are inferred on this page.</p>
            <button type="button" onClick={() => navigate('/campaigner')} className="w-full py-2 rounded-xl bg-[var(--s3)] hover:bg-[var(--b1)] text-t1 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> Review campaign setup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
