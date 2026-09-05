import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Star, CheckCircle2, Sparkles, TrendingUp, MessageSquare, ShieldCheck, BellRing, Inbox } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import ResourceSection from '../components/ui/ResourceSection';
import { useResource } from '../hooks/useResource';
import { LOADING_STATE, receivedData, type ResourceState } from '../lib/resourceState';
import { fetchList, mapProviderProfile, mapReview, type ApiProviderProfile, type ApiReview, type ReviewRow } from '../lib/apiAdapters';
import { apiRequest } from '../lib/api';
import { formatRatingThreshold, growthPolicyProvenance, loadGrowthPolicy, type GrowthPolicy } from '../lib/growthPolicy';
import { useSession } from '../hooks/useSession';
import { hasPermission } from '../lib/access';

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

interface BranchOption { id: string; name: string }

/** The slice this screen actually asks for; every count below is of this slice. */
const REVIEW_PAGE_SIZE = 100;

/**
 * How many providers the "Top Provider Ratings" card lists.
 *
 * This is a PAGE SIZE, not a clinic rule: it decides how much of a ranked list
 * fits in a sidebar card, and no clinic would ever want to configure it. It is
 * named rather than configured, and the card says how many of the ranked
 * providers it is showing — a truncated list that does not admit it is a list
 * that reads as "these are all of them".
 */
const TOP_PROVIDER_LIST_SIZE = 5;

/**
 * How many reputation cases and review requests `/v1/reputation` is asked for.
 *
 * Also a page size. It matters in the copy because `summary.pendingReviewRequests`
 * is counted over the rows the request returned, NOT over every request in the
 * workspace — so the tile that prints it has to say which set it counted.
 */
const REPUTATION_PAGE_SIZE = 10;

// Module-scope loaders: useResource keys a request by the identity of its
// source, so these must not be re-created on every render.
const loadReviews = async (signal: AbortSignal): Promise<ReviewRow[]> =>
  (await fetchList<ApiReview>(`/v1/reviews?limit=${REVIEW_PAGE_SIZE}`, signal)).map(mapReview);
const loadBranches = (signal: AbortSignal) => fetchList<BranchOption>('/v1/branches?limit=100', signal);
const loadProviders = async (signal: AbortSignal) =>
  (await fetchList<ApiProviderProfile>('/v1/providers/overview?limit=100', signal)).map(mapProviderProfile);
const REPUTATION_PATH = `/v1/reputation?limit=${REPUTATION_PAGE_SIZE}`;

/**
 * Two feeds, one claim.
 *
 * A panel that reads from two requests can only speak once both have answered:
 * pairing a loaded list with a missing one would silently narrow the claim
 * ("0 reviews at this clinic" when the reviews never arrived). This composes the
 * shared contract rather than replacing it — the result is an ordinary
 * ResourceState and goes straight into ResourceSection. Worth lifting into
 * lib/resourceState.ts the next time that file is open.
 */
function combineResourceStates<A, B, R>(
  a: ResourceState<A>,
  b: ResourceState<B>,
  merge: (a: A, b: B) => R,
): ResourceState<R> {
  if (a.status === 'error') return a;
  if (b.status === 'error') return b;
  if (a.status === 'loading' || b.status === 'loading') return LOADING_STATE;
  return { status: 'ready', data: merge(a.data, b.data), receivedAt: Math.max(a.receivedAt, b.receivedAt) };
}

function platformLabel(platform: string) {
  return platform.trim() || 'Platform not recorded';
}

/**
 * Colour band for a clinic's average rating.
 *
 * The bounds used to be written into the JSX as `>= 4.5` and `>= 4`, so every
 * tenant on the platform was told the same thing about what "good" means. They
 * are now the tenant's own `reviewRatingGood` / `reviewRatingFair`, and the
 * threshold is only reachable from a resolved policy — the function cannot be
 * called without one, which is what stops a band being drawn from a guess.
 *
 * Both bounds are INCLUSIVE LOWER bounds, matching the comparison semantics
 * recorded in server/modules/growth/defaults.ts.
 */
function ratingBandClass(average: number, policy: GrowthPolicy): string {
  if (average >= policy.reviewRatingGood) return 'text-emerald-v';
  if (average >= policy.reviewRatingFair) return 'text-amber-v';
  return 'text-red-v';
}

export default function Reviews() {
  const navigate = useNavigate();
  const { user } = useSession();
  const canRespond = hasPermission(user, 'crm:write');
  const reviews = useResource<ReviewRow[]>(loadReviews);
  const branches = useResource<BranchOption[]>(loadBranches);
  const providers = useResource<ReturnType<typeof mapProviderProfile>[]>(loadProviders);
  const reputation = useResource<ReputationResponse>(REPUTATION_PATH);
  // The clinic's own rating bands. A feed like any other: until it answers,
  // there is no band to draw, and if it fails, the panel that bands says so.
  const policy = useResource<GrowthPolicy>(loadGrowthPolicy);

  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState('all');
  const [editorId, setEditorId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Page-level rather than per-row: recording a response reloads the feed, so a
  // notice living inside the row would be unmounted before it could be read.
  const [responseNotice, setResponseNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const receivedReputation = receivedData(reputation.state);

  /**
   * Records the response the member of staff wrote. There is deliberately no
   * default text: the previous build shipped one canned compliment and filed it
   * verbatim against every review including one-star ones.
   */
  async function respondToReview(id: string) {
    const response = (drafts[id] ?? '').trim();
    if (!response) return;
    setRespondingId(id);
    setResponseNotice(null);
    try {
      await apiRequest(`/v1/reviews/${id}/respond`, {
        method: 'PATCH',
        body: JSON.stringify({ response }),
      });
      setEditorId(null);
      setDrafts(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      reviews.reload();
      setResponseNotice({ kind: 'ok', text: 'Saved against this review in CareCommand. It has not been published to the source platform — publish it there if you want the public to see it.' });
    } catch (error) {
      setResponseNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to record response' });
    } finally {
      setRespondingId(null);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Reviews"
        subtitle="Read stored patient feedback, record a staff response, and prepare governed review-request campaigns."
        // "N need review" is a safety claim about open cases, so it waits for
        // the reputation response instead of counting an unanswered request.
        badge={
          reputation.state.status === 'loading' ? 'Loading reputation'
            : reputation.state.status === 'error' ? 'Data unavailable'
              : `${receivedReputation?.summary.unresolvedCases ?? 0} need review`
        }
        badgeColor={
          reputation.state.status === 'error' ? 'red'
            : reputation.state.status === 'loading' ? 'blue'
              : (receivedReputation?.summary.unresolvedCases ?? 0) > 0 ? 'amber' : 'emerald'
        }
        actions={
          <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Review campaign setup
          </button>
        }
      />

      {responseNotice && (
        <div
          role={responseNotice.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-2xl border border-[var(--b1)] px-4 py-3 text-sm ${responseNotice.kind === 'error' ? 'bg-[var(--red-soft)] text-red-v' : 'bg-[var(--emerald-soft)] text-emerald-v'}`}
        >
          {responseNotice.text}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <ResourceSection
          label="Review figures"
          state={reviews.state}
          onRetry={reviews.reload}
          className="col-span-2 lg:col-span-3"
          compact
          loading={<>{[0, 1, 2].map(i => <div key={i} className="skeleton-line h-24 rounded-2xl" />)}</>}
          // A workspace with no reviews is a real answer; the tiles say so.
          isEmpty={() => false}
        >
          {rows => {
            // Only rows that actually carry a number contribute to the average,
            // and the subtitle names that denominator.
            const rated = rows.filter((review): review is ReviewRow & { rating: number } => review.rating != null);
            const avgRating = rated.length > 0
              ? (rated.reduce((sum, review) => sum + review.rating, 0) / rated.length).toFixed(1)
              : null;
            // Sentiment is a free-text column; an unrecognised value is not
            // "neutral", it is unclassified, and it is excluded from the split
            // instead of being counted against "positive".
            const classified = rows.filter(review => review.sentiment != null);
            const positiveCount = rows.filter(review => review.sentiment === 'positive').length;
            const sentimentPct = classified.length > 0 ? Math.round((positiveCount / classified.length) * 100) : null;
            return (
              <>
                <StatCard
                  title="Average rating"
                  value={avgRating ?? 'No ratings recorded'}
                  subtitle={rated.length > 0 ? `Across ${rated.length} rated review${rated.length === 1 ? '' : 's'}` : 'No loaded review carries a rating'}
                  icon={<Star className="w-4 h-4" />}
                  accent="amber"
                />
                <StatCard
                  title="Reviews loaded"
                  value={rows.length}
                  subtitle={`Most recent ${REVIEW_PAGE_SIZE}`}
                  icon={<MessageSquare className="w-4 h-4" />}
                  accent="blue"
                />
                <StatCard
                  title="Positive sentiment"
                  value={sentimentPct === null ? 'Not classified' : `${sentimentPct}%`}
                  subtitle={classified.length > 0 ? `Of ${classified.length} classified review${classified.length === 1 ? '' : 's'}` : 'No loaded review carries a known sentiment'}
                  icon={<TrendingUp className="w-4 h-4" />}
                  accent="emerald"
                />
              </>
            );
          }}
        </ResourceSection>

        <ResourceSection
          label="Reputation figures"
          state={reputation.state}
          onRetry={reputation.reload}
          className="col-span-2"
          compact
          loading={<>{[0, 1].map(i => <div key={i} className="skeleton-line h-24 rounded-2xl" />)}</>}
        >
          {data => (
            <>
              <StatCard title="Review-risk score" value={`${data.summary.avgBadReviewRisk}%`} subtitle="Average recorded risk across your reputation cases · a planning figure" icon={<ShieldCheck className="w-4 h-4" />} accent="red" />
              <StatCard title="Pending requests" value={data.summary.pendingReviewRequests} subtitle={`Not yet sent or delivered, of the ${REPUTATION_PAGE_SIZE} most recent`} icon={<BellRing className="w-4 h-4" />} accent="violet" />
            </>
          )}
        </ResourceSection>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <BentoCard title="Review feed">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] leading-relaxed text-t2">The {REVIEW_PAGE_SIZE} most recent reviews stored in this workspace. Page figures remain network-wide; the filter below narrows the feed.</p>
              <select aria-label="Review clinic filter" value={selectedBranchId} onChange={event => setSelectedBranchId(event.target.value)} className="rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-xs font-semibold text-t1">
                <option value="all">All clinics</option>
                {(receivedData(branches.state) ?? []).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </div>
            <ResourceSection
              label="Review feed"
              state={reviews.state}
              onRetry={reviews.reload}
              lines={3}
              rowClassName="h-32 rounded-2xl"
              empty={{
                icon: <Inbox className="w-5 h-5" />,
                title: 'No reviews recorded yet',
                description: 'The review feed loaded and this workspace has no stored reviews yet. A governed request campaign is how you start asking patients for them.',
                cta: { label: 'Review campaign setup', onClick: () => navigate('/campaigner') },
              }}
            >
              {rows => {
                const filteredRows = rows.filter(review => selectedBranchId === 'all' || review.branchId === selectedBranchId);
                return (
                <div className="space-y-3">
                  {filteredRows.length === 0 && selectedBranchId !== 'all' && (
                    <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-6 text-center">
                      <p className="text-sm font-semibold text-t1">No reviews in the selected clinic</p>
                      <p className="mt-1 text-xs text-t3">The network-wide feed loaded, but none of these {REVIEW_PAGE_SIZE} recent records belong to this clinic.</p>
                    </div>
                  )}
                  {filteredRows.map((r) => {
                    const draft = drafts[r.id] ?? '';
                    const prefilled = !r.responded && !!r.storedResponse;
                    const rating = r.rating;
                    return (
                    <div key={r.id} className={`p-4 rounded-2xl border transition-all hover:bg-[var(--s3)] ${
                      r.sentiment === 'negative' ? 'border-[var(--b2)] bg-[var(--red-soft)]' : 'border-[var(--b1)]'
                    }`}>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-[var(--s3)] flex items-center justify-center text-t3 shrink-0" aria-hidden="true">
                            <MessageSquare className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            {/* The reviews endpoint returns no author, so the
                                row says so rather than showing a placeholder
                                styled like a real name. */}
                            <p className="text-xs font-semibold text-t3">No reviewer name on this record</p>
                            <p className="text-[10px] font-semibold text-t2">{(receivedData(branches.state) ?? []).find(branch => branch.id === r.branchId)?.name ?? 'Clinic not resolved'}</p>
                            <div className="flex items-center gap-1">
                              {rating == null
                                ? <span className="text-[10px] font-semibold text-t3">Rating not recorded</span>
                                : [...Array(5)].map((_, i) => (
                                  <Star key={i} className={`w-3 h-3 ${i < rating ? 'fill-amber-400 text-amber-400' : 'text-t3 fill-[var(--s3)]'}`} />
                                ))}
                              <span className="text-[10px] text-t3 ml-1">{r.date}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {/* The stored platform string, uncoerced: a Yelp row
                              reads "yelp", not "internal". */}
                          <span className="badge badge-blue capitalize">{platformLabel(r.platform)}</span>
                          <span className={`badge ${r.sentiment === 'positive' ? 'badge-emerald' : r.sentiment === 'negative' ? 'badge-red' : 'badge-blue'}`}>
                            {r.sentiment ?? 'sentiment not classified'}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-t2 leading-relaxed mb-3">"{r.text}"</p>
                      {r.responded && r.storedResponse && (
                        <div className="p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--b1)] mb-2">
                          <p className="text-[10px] font-bold text-t3 mb-1">Response recorded</p>
                          <p className="text-xs text-t2">{r.storedResponse}</p>
                        </div>
                      )}

                      {r.responded ? (
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-v"><CheckCircle2 className="w-3 h-3" /> Responded</span>
                      ) : !canRespond ? (
                        <span className="text-[10px] font-semibold text-t3">Read-only access · a CRM editor must record the response</span>
                      ) : editorId === r.id ? (
                        <div className="space-y-2">
                          <label htmlFor={`review-response-${r.id}`} className="block text-[10px] font-bold uppercase tracking-widest text-t3">
                            Your response
                          </label>
                          <textarea
                            id={`review-response-${r.id}`}
                            value={draft}
                            rows={4}
                            onChange={event => setDrafts(current => ({ ...current, [r.id]: event.target.value }))}
                            placeholder="Write the reply this clinic should stand behind for this review."
                            className="w-full resize-y rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs leading-relaxed text-t1 outline-none focus:border-[var(--b2)]"
                          />
                          <p className="text-[11px] leading-snug text-t2">
                            {prefilled
                              ? 'Prefilled from the draft stored on this review. Check it against this rating before you record it.'
                              : 'This is saved against the review in CareCommand. Publishing it to the source platform is a separate step, taken there.'}
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={!draft.trim() || respondingId === r.id}
                              onClick={() => void respondToReview(r.id)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
                            >
                              <CheckCircle2 className="w-3 h-3" /> {respondingId === r.id ? 'Recording…' : 'Record response'}
                            </button>
                            <button type="button" onClick={() => setEditorId(null)} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t3 hover:bg-[var(--s3)]">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditorId(r.id);
                            setDrafts(current => ({ ...current, [r.id]: current[r.id] ?? r.storedResponse ?? '' }));
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo-soft)] px-3 py-1.5 text-xs font-semibold text-indigo transition-colors hover:opacity-80"
                        >
                          <MessageSquare className="w-3 h-3" /> {r.storedResponse ? 'Review stored draft and respond' : 'Write a response'}
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
                );
              }}
            </ResourceSection>
          </BentoCard>
        </div>

        <div className="space-y-4">
          <BentoCard title="Reputation follow-up" subtitle="Unresolved cases and recorded recovery guidance">
            <ResourceSection
              label="Reputation cases"
              state={reputation.state}
              onRetry={reputation.reload}
              lines={2}
              rowClassName="h-24 rounded-xl"
              isEmpty={data => data.cases.length === 0}
              empty={{
                icon: <ShieldCheck className="w-5 h-5" />,
                title: 'No open reputation cases',
                description: 'The reputation feed loaded and this clinic has no unresolved cases on record. Nothing here needs a recovery step right now.',
              }}
            >
              {data => (
                <div className="space-y-3">
                  {data.cases.map((item) => (
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
                        <p className="text-[10px] font-bold uppercase tracking-wide text-t3 mb-1">Draft message · read it before you use it</p>
                        <p className="text-xs text-t2">{item.suggestedReply}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ResourceSection>
          </BentoCard>

          <BentoCard title="Review requests" subtitle="Recorded request and response status">
            <ResourceSection
              label="Review requests"
              state={reputation.state}
              onRetry={reputation.reload}
              lines={2}
              rowClassName="h-16 rounded-xl"
              isEmpty={data => data.reviewRequests.length === 0}
              empty={{
                icon: <BellRing className="w-5 h-5" />,
                title: 'No review requests recorded',
                description: 'The reputation feed loaded and no review request has been recorded for this clinic yet. A governed campaign is how you send the first one.',
                cta: { label: 'Review campaign setup', onClick: () => navigate('/campaigner') },
              }}
            >
              {data => (
                <div className="space-y-2.5">
                  {data.reviewRequests.map((request) => (
                    <div key={request.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)]">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-t1">{request.requestType}</p>
                        <p className="text-[10px] text-t3 mt-0.5">{request.branch.name} · {request.channel.toLowerCase()} · {request.status}</p>
                        <p className="text-[11px] text-t2 mt-2">{request.message}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-bold text-t1">{request.ratingReceived ? `${request.ratingReceived}★` : 'No rating'}</p>
                        <p className="text-[10px] text-t3">{request.respondedAt ? 'Responded' : 'Waiting'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ResourceSection>
          </BentoCard>

          <BentoCard title="Rating Distribution">
            <p className="mb-3 text-[12px] leading-relaxed text-t2">
              Across the {REVIEW_PAGE_SIZE} most recent stored reviews.
            </p>
            <ResourceSection
              label="Rating distribution"
              state={reviews.state}
              onRetry={reviews.reload}
              lines={5}
              rowClassName="h-4 rounded-full"
              empty={{
                icon: <Star className="w-5 h-5" />,
                title: 'No reviews to distribute',
                description: 'The review feed loaded and this workspace has no stored reviews yet, so there is nothing to distribute.',
              }}
            >
              {rows => {
                const rated = rows.filter(review => review.rating != null);
                const unrated = rows.length - rated.length;
                const ratingDist = [5, 4, 3, 2, 1].map(rating => ({ star: rating, count: rated.filter(review => review.rating === rating).length }));
                return (
                  <div className="space-y-2.5">
                    {ratingDist.map(({ star, count }) => (
                      <div key={star} className="flex items-center gap-2">
                        <div className="flex items-center gap-0.5 w-16 shrink-0">
                          {[...Array(star)].map((_, i) => <Star key={i} className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />)}
                        </div>
                        <div className="flex-1"><ProgressBar value={count} max={rated.length} color={star >= 4 ? 'emerald' : star === 3 ? 'amber' : 'red'} /></div>
                        <span className="text-xs font-bold text-t2 w-4 text-right shrink-0">{count}</span>
                      </div>
                    ))}
                    {unrated > 0 && (
                      <p className="text-[11px] leading-snug text-t2">{unrated} loaded review{unrated === 1 ? ' carries' : 's carry'} no rating and {unrated === 1 ? 'is' : 'are'} not counted above.</p>
                    )}
                  </div>
                );
              }}
            </ResourceSection>
          </BentoCard>

          <BentoCard title="Rating by clinic">
            {/* Three feeds: the clinic list, the reviews being averaged, and the
                bands they are judged against. All three have to answer before a
                coloured per-clinic average means anything — a green 4.4 under a
                tenant whose "good" starts at 4.6 is a wrong claim, not a late
                one, so the policy waits with the rest. */}
            <ResourceSection
              label="Clinic ratings"
              state={combineResourceStates(
                combineResourceStates(branches.state, reviews.state, (branchRows, reviewRows) => ({ branchRows, reviewRows })),
                policy.state,
                (rows, bands) => ({ ...rows, bands }),
              )}
              onRetry={() => { branches.reload(); reviews.reload(); policy.reload(); }}
              lines={3}
              rowClassName="h-14 rounded-xl"
              isEmpty={data => data.branchRows.length === 0}
              empty={{
                title: 'No clinics recorded',
                description: 'The clinic list loaded and this workspace has no clinic records to rate.',
              }}
            >
              {({ branchRows, reviewRows, bands }) => (
                <div className="space-y-2.5">
                  {/* The bands are stated, and stated as the configured values.
                      The card used to colour silently against 4.5 / 4.0 and
                      never told anyone that was the rule. */}
                  <p className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-[12px] leading-relaxed text-t2">
                    Each clinic&rsquo;s average across the {REVIEW_PAGE_SIZE} most recent stored reviews.{' '}
                    Green at ≥ {formatRatingThreshold(bands.reviewRatingGood)}, amber at ≥ {formatRatingThreshold(bands.reviewRatingFair)}, red below.{' '}
                    {growthPolicyProvenance(bands)}
                  </p>
                  {branchRows.map((b) => {
                    const rated = reviewRows.filter((r): r is ReviewRow & { rating: number } => r.branchId === b.id && r.rating != null);
                    const avg = rated.length > 0 ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null;
                    return (
                      <div key={b.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                        <div>
                          <p className="text-xs font-bold text-t1">{b.name.split(' ')[0]}</p>
                          <p className="text-[10px] text-t3">{rated.length} rated review{rated.length === 1 ? '' : 's'}</p>
                        </div>
                        {avg === null ? (
                          <span className="text-[10px] font-semibold text-t3 shrink-0">No rated reviews</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                            <span className={`text-sm font-bold ${ratingBandClass(avg, bands)}`}>{avg.toFixed(1)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </ResourceSection>
          </BentoCard>

          <BentoCard title="Top Provider Ratings">
            <p className="mb-3 text-[12px] leading-relaxed text-t2">
              Ranked by recorded rating. Only providers with at least one recorded review appear here.
            </p>
            <ResourceSection
              label="Provider ratings"
              state={providers.state}
              onRetry={providers.reload}
              lines={3}
              rowClassName="h-6 rounded-lg"
              // ProviderProfile.rating defaults to 0, so a provider with no
              // reviews would otherwise be published as a 0.0-star clinician.
              isEmpty={rows => rows.filter(doc => doc.reviewCount > 0 && Number.isFinite(doc.rating)).length === 0}
              empty={{
                icon: <Star className="w-5 h-5" />,
                title: 'No provider has a recorded rating',
                description: 'The provider feed loaded and no provider has a review recorded against them yet, so there is no ranking to draw.',
              }}
            >
              {rows => {
                const ranked = rows
                  .filter(doc => doc.reviewCount > 0 && Number.isFinite(doc.rating))
                  .sort((a, b) => b.rating - a.rating);
                const visible = ranked.slice(0, TOP_PROVIDER_LIST_SIZE);
                return (
                  <div className="space-y-2.5">
                    {visible.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold text-t1 truncate">{doc.name}</p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                          <span className="text-xs font-bold text-t1">{doc.rating.toFixed(1)}</span>
                          <span className="text-[10px] text-t3">({doc.reviewCount})</span>
                        </div>
                      </div>
                    ))}
                    {/* A cut list that does not say it was cut reads as the
                        whole list. The cap is a card size, so it is named as
                        one rather than dressed up as a clinical cut-off. */}
                    {ranked.length > visible.length && (
                      <p className="text-[11px] leading-snug text-t2">
                        Highest {visible.length} of {ranked.length} providers with a recorded rating.
                      </p>
                    )}
                  </div>
                );
              }}
            </ResourceSection>
          </BentoCard>

          <div className="rounded-2xl bg-[var(--s2)] border border-[var(--b1)] p-4">
            <p className="text-sm font-bold text-t1 mb-1">Referral workflow not available</p>
            <p className="text-xs leading-relaxed text-t2">CareCommand does not currently create, route, or attribute patient referrals. Use the clinic’s approved referral process; this workspace will not imply that a campaign is a referral workflow.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
