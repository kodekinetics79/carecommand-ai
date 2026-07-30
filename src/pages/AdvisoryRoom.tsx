import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Sparkles, BrainCircuit, ArrowRight, ShieldCheck, TrendingUp, Users2, Radar, Clock, Bot } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { useApiResource } from '../hooks/useApiResource';
import { formatCurrency } from '../utils/formatters';
import { askAdvisory, fetchAdvisoryBrief, getAdvisorDisplay, getAdvisorSampleQuestions } from '../lib/advisory';
import type { AdvisorResponse, AdvisorType } from '../types';

type BranchOption = { id: string; name: string; location: string };

const advisorMeta: Record<AdvisorType, { icon: ReactNode; accent: string; description: string }> = {
  revenue: { icon: <TrendingUp className="w-4 h-4" />, accent: 'emerald', description: 'Recover value from leaks, missed calls, and dormant patients.' },
  growth: { icon: <Users2 className="w-4 h-4" />, accent: 'blue', description: 'Grow bookings with campaign and lifecycle guidance.' },
  'front-desk': { icon: <Bot className="w-4 h-4" />, accent: 'violet', description: 'Coach the front desk, queues, and follow-up tasks.' },
  competitor: { icon: <Radar className="w-4 h-4" />, accent: 'amber', description: 'Spot market openings and respond to local competition.' },
  operations: { icon: <ShieldCheck className="w-4 h-4" />, accent: 'cyan', description: 'Balance capacity, staffing, and schedule flow.' },
};

const advisorOrder: AdvisorType[] = ['revenue', 'growth', 'front-desk', 'competitor', 'operations'];

export default function AdvisoryRoom() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: clinicOptions } = useApiResource<BranchOption, BranchOption>('/v1/branches?limit=100', [], row => row);
  const initialState = (location.state as { question?: string; advisorType?: AdvisorType } | null) ?? null;
  const [selectedClinicId, setSelectedClinicId] = useState<'all' | string>('all');
  const [selectedAdvisor, setSelectedAdvisor] = useState<AdvisorType>(initialState?.advisorType ?? 'revenue');
  const [question, setQuestion] = useState(initialState?.question ?? 'What should I focus on first today?');
  const [brief, setBrief] = useState<Awaited<ReturnType<typeof fetchAdvisoryBrief>> | null>(null);
  const [activeAnswer, setActiveAnswer] = useState<AdvisorResponse | null>(null);
  const [briefLoading, setBriefLoading] = useState(true);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [askLoading, setAskLoading] = useState(false);
  const selectedAdvisorRef = useRef(selectedAdvisor);

  useEffect(() => {
    selectedAdvisorRef.current = selectedAdvisor;
  }, [selectedAdvisor]);

  useEffect(() => {
    if (!initialState) return;
    navigate('/advisory', { replace: true, state: null });
  }, [initialState, navigate]);

  const selectedAdvisorData = useMemo(() => {
    if (!brief) return null;
    return brief.advisors.find(advisor => advisor.advisorType === selectedAdvisor) ?? brief.advisors[0] ?? null;
  }, [brief, selectedAdvisor]);

  useEffect(() => {
    let active = true;
    async function loadBrief() {
      setBriefLoading(true);
      setBriefError(null);
      try {
        const response = await fetchAdvisoryBrief(selectedClinicId === 'all' ? undefined : selectedClinicId);
        if (!active) return;
        setBrief(response);
        const selected = response.advisors.find(advisor => advisor.advisorType === selectedAdvisorRef.current) ?? response.advisors[0] ?? null;
        setActiveAnswer(selected);
      } catch (error) {
        if (!active) return;
        setBriefError(error instanceof Error ? error.message : 'Unable to load advisory room');
      } finally {
        if (active) setBriefLoading(false);
      }
    }

    void loadBrief();
    return () => {
      active = false;
    };
  }, [selectedClinicId]);

  async function handleAsk(advisorType = selectedAdvisor, questionOverride?: string) {
    const nextQuestion = (questionOverride ?? question).trim();
    if (!nextQuestion) return;
    setAskLoading(true);
    try {
      const response = await askAdvisory(nextQuestion, advisorType, selectedClinicId === 'all' ? undefined : selectedClinicId);
      setActiveAnswer(response);
      setSelectedAdvisor(advisorType);
    } catch (error) {
      setBriefError(error instanceof Error ? error.message : 'Unable to load advisory answer');
    } finally {
      setAskLoading(false);
    }
  }

  function focusAdvisor(advisorType: AdvisorType) {
    setSelectedAdvisor(advisorType);
    if (brief) {
      const advisor = brief.advisors.find(item => item.advisorType === advisorType);
      if (advisor) setActiveAnswer(advisor);
    }
    const sample = getAdvisorSampleQuestions(advisorType)[0];
    if (!question.trim() || question === 'What should I focus on first today?') {
      setQuestion(sample);
    }
    void handleAsk(advisorType, sample);
  }

  const currentAnswer = activeAnswer ?? selectedAdvisorData;
  const currentActions = currentAnswer?.actions ?? [];

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Advisory Room"
        subtitle="A built-in advisory team for revenue, growth, front desk, competition, and operations."
        badge={briefLoading ? 'Loading' : brief ? 'Live Advisory' : 'Fallback'}
        badgeColor="emerald"
        actions={
          <button type="button" onClick={() => navigate('/opportunities')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Open Revenue Leaks
          </button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <BentoCard title="Your Advisory Team" subtitle="Choose the advisor that should answer first">
            {briefError && (
              <div className="mb-4 rounded-xl border border-[var(--red-soft)] bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v">
                {briefError}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {advisorOrder.map(advisorType => {
                const meta = advisorMeta[advisorType];
                const advisor = brief?.advisors.find(item => item.advisorType === advisorType);
                const selected = selectedAdvisor === advisorType;
                return (
                  <button
                    key={advisorType}
                    type="button"
                    onClick={() => focusAdvisor(advisorType)}
                    className={`rounded-2xl border p-4 text-left transition-all hover:bg-[var(--s3)] ${selected ? 'border-[var(--indigo)] bg-[var(--indigo-soft)]' : 'border-[var(--b1)] bg-[var(--s2)]'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${meta.accent === 'emerald' ? 'bg-[var(--emerald-soft)] text-emerald-v' : meta.accent === 'blue' ? 'bg-[var(--blue-soft)] text-blue-v' : meta.accent === 'violet' ? 'bg-[var(--violet-soft)] text-violet-v' : meta.accent === 'amber' ? 'bg-[var(--amber-soft)] text-amber-v' : 'bg-[var(--cyan-soft)] text-cyan-v'}`}>
                        {meta.icon}
                      </div>
                      <span className={`badge ${selected ? 'badge-indigo' : 'badge-blue'}`}>{advisor ? `${advisor.confidence}%` : '...'}</span>
                    </div>
                    <p className="mt-3 text-sm font-bold text-t1">{getAdvisorDisplay(advisorType)}</p>
                    <p className="mt-1 text-xs text-t3 leading-relaxed">{meta.description}</p>
                    {advisor && (
                      <>
                        <p className="mt-3 text-xs font-semibold text-t1 leading-relaxed">{advisor.summary}</p>
                        <p className="mt-2 text-xs text-t3">Expected impact: {formatCurrency(advisor.expectedImpact)}</p>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </BentoCard>

          <BentoCard title="Ask the Room" subtitle="Try a question or choose a sample prompt">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <p className="text-xs font-semibold text-t2">Clinic scope</p>
              <select
                value={selectedClinicId}
                onChange={e => setSelectedClinicId(e.target.value)}
                className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t1 outline-none"
              >
                <option value="all">All clinics</option>
                {clinicOptions.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
              </select>
              {brief?.clinicName && brief.clinicName !== 'All clinics' && (
                <span className="badge badge-emerald">{brief.clinicName}</span>
              )}
            </div>

            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              rows={4}
              className="w-full rounded-2xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-3 text-sm text-t1 outline-none focus:border-[var(--indigo)] focus:ring-2 focus:ring-[var(--indigo-soft)] transition"
              placeholder="Ask about revenue, growth, front desk, competitors, or operations..."
            />

            <div className="mt-3 flex flex-wrap gap-2">
              {getAdvisorSampleQuestions(selectedAdvisor).map(sample => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => setQuestion(sample)}
                  className="rounded-full border border-[var(--b1)] bg-[var(--s3)] px-3 py-1.5 text-xs text-t2 hover:bg-[var(--indigo-soft)] hover:text-indigo transition"
                >
                  {sample}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={askLoading}
                onClick={() => void handleAsk()}
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition disabled:opacity-40"
              >
                <BrainCircuit className="w-4 h-4" /> {askLoading ? 'Thinking…' : 'Ask Advisor'}
              </button>
              <button
                type="button"
                onClick={() => navigate('/crm')}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] transition"
              >
                <Users2 className="w-4 h-4" /> Open CRM
              </button>
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          <BentoCard title={currentAnswer ? getAdvisorDisplay(currentAnswer.advisorType) : 'Advisor Answer'} subtitle="A clear answer connected to real actions">
            {briefLoading && !brief ? (
              <div className="space-y-3">
                <div className="skeleton h-5 w-2/3 rounded-lg" />
                <div className="skeleton h-24 rounded-2xl" />
                <div className="skeleton h-16 rounded-2xl" />
              </div>
            ) : currentAnswer ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-sm font-semibold text-t1 leading-relaxed">{currentAnswer.summary}</p>
                    <span className="badge badge-emerald">{currentAnswer.confidence}% confidence</span>
                  </div>
                  <p className="text-sm text-t2 leading-relaxed">{currentAnswer.answer}</p>
                </div>

                <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-t3 mb-2">Diagnosis</p>
                  <p className="text-sm text-t1 leading-relaxed">{currentAnswer.diagnosis}</p>
                </div>

                <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-xs font-bold uppercase tracking-widest text-t3">Expected Impact</p>
                    <span className="text-sm font-bold text-emerald-v">{formatCurrency(currentAnswer.expectedImpact)}</span>
                  </div>
                  <ProgressBar value={currentAnswer.confidence} color={currentAnswer.confidence >= 85 ? 'emerald' : currentAnswer.confidence >= 70 ? 'amber' : 'blue'} />
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                    <p className="text-xs font-bold uppercase tracking-widest text-t3 mb-3">Evidence</p>
                    <div className="space-y-2">
                      {currentAnswer.evidence.map(item => (
                        <div key={item} className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t2 leading-relaxed">
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                    <p className="text-xs font-bold uppercase tracking-widest text-t3 mb-3">Recommendations</p>
                    <div className="space-y-2">
                      {currentAnswer.recommendations.map(item => (
                        <div key={item} className="flex items-start gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t2 leading-relaxed">
                          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo" />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-t3">Ask a question to load an advisory answer.</p>
            )}
          </BentoCard>

          <BentoCard title="Recommended Actions" subtitle="Everything connects back to the product">
            <div className="grid gap-2">
              {currentActions.map(action => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => navigate(action.path, action.path === '/campaigner' ? { state: currentAnswer ? { advisorType: currentAnswer.advisorType, question, recommendedAction: currentAnswer.recommendedAction, summary: currentAnswer.summary } : undefined } : undefined)}
                  className={`flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition hover:bg-[var(--s3)] ${action.primary ? 'border-[var(--indigo)] bg-[var(--indigo-soft)]' : 'border-[var(--b1)] bg-[var(--s2)]'}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-t1">{action.label}</p>
                    <p className="mt-1 text-xs text-t3 leading-relaxed">{action.description}</p>
                  </div>
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-indigo" />
                </button>
              ))}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button type="button" onClick={() => navigate('/opportunities')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s3)] transition">
                  <TrendingUp className="h-3.5 w-3.5" /> Open Revenue Leaks
                </button>
                <button type="button" onClick={() => navigate('/staff')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s3)] transition">
                  <Clock className="h-3.5 w-3.5" /> Review Staff Queue
                </button>
              </div>
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
