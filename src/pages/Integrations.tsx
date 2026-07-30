import { useEffect, useMemo, useState, type ElementType } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CreditCard,
  Globe2,
  MessagesSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { apiRequest } from '../lib/api';
import { useSession } from '../hooks/useSession';
import type { IntegrationStatus } from '../types';

const iconMap: Record<string, ElementType> = {
  Communication: MessagesSquare,
  Insurance: ShieldCheck,
  Payments: CreditCard,
  'Reputation / Marketing': Globe2,
  'AI Providers': Sparkles,
  default: Cloud,
};

export default function Integrations() {
  const navigate = useNavigate();
  const { user } = useSession();
  const canTest = !!user && ['OWNER', 'ADMIN', 'MANAGER'].includes(user.role);
  const [statusRows, setStatusRows] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  async function loadStatuses() {
    setLoading(true);
    setError(null);
    try {
      const rows = await apiRequest<IntegrationStatus[]>('/v1/integrations/status');
      setStatusRows(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load integrations');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatuses();
  }, []);

  const categories = useMemo(() => ['All', ...new Set(statusRows.map(row => row.category))], [statusRows]);
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return statusRows.filter(row => {
      const matchesCategory = category === 'All' || row.category === category;
      const matchesSearch = !term
        || row.name.toLowerCase().includes(term)
        || row.description.toLowerCase().includes(term)
        || row.category.toLowerCase().includes(term);
      return matchesCategory && matchesSearch;
    });
  }, [category, search, statusRows]);

  const configuredCount = statusRows.filter(row => row.configured).length;
  const healthyCount = statusRows.filter(row => row.health === 'healthy').length;
  const mockCount = statusRows.filter(row => row.mode === 'mock').length;
  const sandboxCount = statusRows.filter(row => row.mode === 'sandbox').length;

  async function testConnection(providerKey: string) {
    if (!canTest) return;
    setTestingKey(providerKey);
    try {
      const result = await apiRequest<{
        providerKey: string;
        providerName: string;
        modeLabel: string;
        health: string;
        configured: boolean;
        message: string;
        supportedWorkflows: string[];
        missingEnvVars: string[];
        riskLevel: string;
      }>(`/v1/integrations/${providerKey}/test`, { method: 'POST' });
      setTestResults(current => ({
        ...current,
        [providerKey]: `${result.modeLabel} · ${result.message}`,
      }));
      await loadStatuses();
    } catch (err) {
      setTestResults(current => ({
        ...current,
        [providerKey]: err instanceof Error ? err.message : 'Test failed',
      }));
    } finally {
      setTestingKey(null);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Integrations Hub"
        subtitle="Operational status for insurance, payments, communication, reputation, and AI providers."
        badge={`${configuredCount} configured · ${loading ? 'Loading…' : 'Live status'}`}
        badgeColor="blue"
        actions={
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition"
          >
            <Sparkles className="w-4 h-4" /> Open Settings
          </button>
        }
      />

      {error && (
        <div className="rounded-2xl border border-[var(--red-soft)] bg-[var(--red-soft)] p-4 text-sm text-red-v">
          {error}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Configured" value={configuredCount} subtitle="Providers ready" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Healthy" value={healthyCount} subtitle="Healthy connections" icon={<ShieldCheck className="w-4 h-4" />} accent="blue" />
        <StatCard title="Sandbox" value={sandboxCount} subtitle="Sandbox-ready or active" icon={<RefreshCw className="w-4 h-4" />} accent="violet" />
        <StatCard title="Mock" value={mockCount} subtitle="Fallback / not configured" icon={<AlertCircle className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <BentoCard title="Integration Status" subtitle="Honest provider readiness and health" headerRight={<Cloud className="w-4 h-4 text-t3" />}>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-t3" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search integrations"
                className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-10 py-2 text-sm text-t1 outline-none focus:border-[var(--b3)]"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {categories.map(item => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setCategory(item)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    category === item ? 'bg-[var(--indigo)] text-white' : 'border border-[var(--b1)] text-t2 hover:bg-[var(--s3)]'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {filteredRows.map(row => {
              const Icon = iconMap[row.category] || iconMap.default;
              const result = testResults[row.key];
              return (
                <div key={row.key} className="rounded-2xl border border-[var(--b1)] p-4 hover:bg-[var(--s3)] transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-2xl bg-[var(--s2)] flex items-center justify-center shrink-0">
                        <Icon className="w-4 h-4 text-t3" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-t1">{row.name}</p>
                        <p className="text-[11px] text-t3">{row.category}</p>
                      </div>
                    </div>
                    <span className={`badge ${
                      row.health === 'healthy' ? 'badge-emerald' :
                      row.health === 'degraded' ? 'badge-amber' :
                      row.health === 'not_configured' ? 'badge-blue' : 'badge-red'
                    }`}>
                      {row.modeLabel}
                    </span>
                  </div>

                  <p className="mt-2 text-[11px] text-t3 leading-relaxed">{row.description}</p>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {row.supportedWorkflows.map(workflow => (
                      <span key={workflow} className="badge badge-indigo">{workflow}</span>
                    ))}
                  </div>

                  <div className="mt-3 grid gap-2 text-[11px] text-t2">
                    <div className="flex items-center justify-between gap-3">
                      <span>Health</span>
                      <span className={`font-semibold ${row.health === 'healthy' ? 'text-emerald-v' : row.health === 'degraded' ? 'text-amber-v' : 'text-t3'}`}>{row.health}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Configured</span>
                      <span className="font-semibold text-t1">{row.configured ? 'Yes' : 'No'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Last check</span>
                      <span className="font-semibold text-t1">{row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString('en-US') : '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Risk</span>
                      <span className={`badge ${row.riskLevel === 'high' ? 'badge-red' : row.riskLevel === 'medium' ? 'badge-amber' : 'badge-emerald'}`}>{row.riskLevel}</span>
                    </div>
                  </div>

                  {row.missingEnvVars.length > 0 && (
                    <p className="mt-3 text-[11px] text-t3">
                      Missing env: {row.missingEnvVars.join(', ')}
                    </p>
                  )}

                  {result && (
                    <div className="mt-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 text-[11px] text-t2">
                      {result}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void testConnection(row.key)}
                    disabled={!canTest || testingKey === row.key}
                    title={!canTest ? 'Your role does not have permission to test provider connections' : ''}
                    className="mt-3 inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-40"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {testingKey === row.key ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
              );
            })}
          </div>
        </BentoCard>

        <div className="space-y-4">
          <BentoCard title="Integration Notes" subtitle="What the owner should know">
            <div className="space-y-2">
              {[
                { title: 'Mock Mode', text: 'Safe fallback when a provider is not configured.' },
                { title: 'Sandbox Ready', text: 'Credentials are present but not actively connected.' },
                { title: 'Sandbox Active', text: 'Configured and ready for test transactions or sandbox calls.' },
                { title: 'Live Not Configured', text: 'Production credentials or activation are not configured.' },
                { title: 'Live Active', text: 'Provider is live and health checks are passing.' },
              ].map(item => (
                <div key={item.title} className="rounded-xl border border-[var(--b1)] p-3">
                  <p className="text-sm font-semibold text-t1">{item.title}</p>
                  <p className="mt-1 text-[11px] text-t3 leading-relaxed">{item.text}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Provider Categories" subtitle="Coverage across the platform">
            <div className="space-y-2">
              {categories.filter(item => item !== 'All').map(item => (
                <div key={item} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] p-3">
                  <span className="text-sm font-semibold text-t1">{item}</span>
                  <span className="badge badge-blue">{statusRows.filter(row => row.category === item).length}</span>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => navigate('/control-plane')}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--b2)] px-4 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Open Control Plane
            </button>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
