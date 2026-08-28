import { Package, AlertCircle, Clock, Zap, Sparkles, ArrowRight, TrendingUp } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { useState } from 'react';
import { useApiResource } from '../hooks/useApiResource';
import { mapInventoryItem, type ApiInventoryItem } from '../lib/apiAdapters';
import { apiRequest } from '../lib/api';
import { formatCurrency } from '../utils/formatters';

interface ApiBranchOption { id: string; name: string }

const statusConfig: Record<string, { label: string; badge: string; border: string; bg: string }> = {
  ok:       { label: 'In Stock',  badge: 'badge badge-emerald', border: 'border-[var(--b1)]',        bg: 'bg-[var(--s2)]' },
  low:      { label: 'Low Stock', badge: 'badge badge-amber',   border: 'border-[var(--b1)]',        bg: 'bg-[var(--amber-soft)]' },
  critical: { label: 'Critical',  badge: 'badge badge-red',     border: 'border-[var(--b1)]',        bg: 'bg-[var(--red-soft)]' },
  expiring: { label: 'Expiring',  badge: 'badge badge-amber',   border: 'border-[var(--b1)]',        bg: 'bg-[var(--amber-soft)]' },
};

const aiRecommendations = [
  { title: 'Reorder Botox immediately', desc: 'Downtown: 3 vials left, 8 appointments next week. 2-day lead time.', urgency: 'Critical', action: 'Place reorder with Allergan UK' },
  { title: 'Use expiring composite resin first', desc: 'Northgate: expires 15 Jun. Prioritise dental fillings to avoid waste.', urgency: 'Expiring', action: 'Schedule usage priority' },
  { title: 'Transfer blood test strips from Downtown', desc: 'Southbank is critically low. Downtown has surplus.', urgency: 'Critical', action: 'Arrange branch transfer' },
];

export default function Inventory() {
  const { data: stockItems, source, error, reload } = useApiResource<ApiInventoryItem, ReturnType<typeof mapInventoryItem>>('/v1/inventory?limit=100', [], mapInventoryItem);
  const { data: branchOptions } = useApiResource<ApiBranchOption, ApiBranchOption>('/v1/branches?limit=100', [], row => row);
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const loadError = error;

  async function reorder(id: string, reorderLevel: number) {
    setReorderingId(id);
    try {
      // Restock to roughly two reorder cycles' worth of stock.
      await apiRequest(`/v1/inventory/${id}`, { method: 'PATCH', body: JSON.stringify({ currentStock: Math.max(reorderLevel * 2, reorderLevel + 10) }) });
      reload();
    } finally {
      setReorderingId(null);
    }
  }

  async function reorderAll() {
    const targets = stockItems.filter(item => item.status === 'critical' || item.status === 'low' || item.status === 'expiring');
    if (targets.length === 0) return;
    setReorderingId('bulk');
    try {
      await Promise.all(targets.map(item => apiRequest(`/v1/inventory/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ currentStock: Math.max(item.reorderLevel * 2, item.reorderLevel + 10) }),
      })));
      reload();
    } finally {
      setReorderingId(null);
    }
  }

  const criticalCount = stockItems.filter(i => i.status === 'critical' || i.status === 'low').length;
  const expiringCount = stockItems.filter(i => i.status === 'expiring').length;
  const totalValue = stockItems.reduce((sum, item) => sum + item.currentStock * item.unitCost, 0);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Inventory Intelligence"
        subtitle="Stock levels, expiry risk, reorder alerts, and AI supply recommendations across all branches."
        badge={loadError ? 'Live Data Error' : `${criticalCount + expiringCount} Alerts · ${source === 'live' ? 'Live DB' : 'Loading'}`}
        badgeColor="red"
        actions={
          <button type="button" disabled={reorderingId === 'bulk'} onClick={() => void reorderAll()} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition disabled:opacity-40">
            <Zap className="w-4 h-4" /> Place All Reorders
          </button>
        }
      />

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Inventory data could not be loaded from the live API: {loadError}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Items Tracked" value={stockItems.length} subtitle="Across all branches" icon={<Package className="w-4 h-4" />} accent="blue" />
        <StatCard title="Critical / Low Stock" value={criticalCount} subtitle="Needs reorder now" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Expiring Soon" value={expiringCount} subtitle="Within 30 days" icon={<Clock className="w-4 h-4" />} accent="amber" />
        <StatCard title="Inventory Value" value={formatCurrency(totalValue)} subtitle="Current stock value" icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Inventory table */}
        <BentoCard title="Stock Level Dashboard" subtitle="All items across branches">
          <div className="space-y-2.5">
            {stockItems.map((item) => {
              const sc = statusConfig[item.status];
              const branch = branchOptions.find(b => b.id === item.branchId);
              const stockPct = Math.min(100, Math.round((item.currentStock / (item.reorderLevel * 2)) * 100));
              const weeksLeft = Math.round(item.currentStock / Math.max(item.usagePerWeek, 0.1));
              return (
                <div key={item.id} className={`p-4 rounded-2xl border transition-all ${sc.border} ${sc.bg}`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-t1">{item.name}</p>
                        <span className={sc.badge}>{sc.label}</span>
                      </div>
                      <p className="text-[11px] text-t3 mt-0.5">{item.category} · {branch?.name.split(' ')[0]} · Supplier: {item.supplier}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-t1">{item.currentStock} {item.unit}</p>
                      <p className="text-[10px] text-t3">Reorder at {item.reorderLevel}</p>
                    </div>
                  </div>

                  <div className="mb-2">
                    <ProgressBar value={stockPct} color={item.status === 'critical' ? 'red' : item.status === 'low' ? 'amber' : item.status === 'expiring' ? 'amber' : 'emerald'} />
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-[11px] text-t3">
                      <span>~{weeksLeft}w left</span>
                      {item.expiryDate && <span className={`font-semibold ${new Date(item.expiryDate) < new Date('2025-07-01') ? 'text-amber-v' : 'text-t3'}`}>Exp: {item.expiryDate}</span>}
                      <span>{formatCurrency(item.unitCost)}/unit</span>
                    </div>
                    {(item.status === 'critical' || item.status === 'low') && (
                      <button type="button" disabled={reorderingId === item.id} onClick={() => reorder(item.id, item.reorderLevel)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1 rounded-lg hover:bg-[var(--s3)] transition-colors disabled:opacity-40">
                        <Zap className="w-3 h-3" /> {reorderingId === item.id ? 'Ordering…' : 'Reorder now'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>

        {/* Right sidebar */}
        <div className="space-y-4">
          <BentoCard title="AI Supply Recommendations" subtitle="Automated intelligence" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            <div className="space-y-3">
              {aiRecommendations.map((rec) => (
                <div key={rec.title} className="p-3.5 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold text-t1 leading-tight">{rec.title}</p>
                    <span className={`badge shrink-0 ${rec.urgency === 'Critical' ? 'badge-red' : 'badge-amber'}`}>{rec.urgency}</span>
                  </div>
                  <p className="text-[11px] text-t3 mb-2">{rec.desc}</p>
                  <button type="button" onClick={() => void reorderAll()} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo hover:opacity-80">
                    <ArrowRight className="w-3 h-3" /> {rec.action}
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Category Breakdown" subtitle="Stock by category">
            <div className="space-y-2.5">
              {['Aesthetics', 'Dental', 'Diagnostics', 'Dermatology', 'Physiotherapy', 'General'].map(cat => {
                const catItems = stockItems.filter(i => i.category === cat);
                const catValue = catItems.reduce((s, i) => s + i.currentStock * i.unitCost, 0);
                const hasIssue = catItems.some(i => i.status !== 'ok');
                return (
                  <div key={cat} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                    <div className="flex items-center gap-2">
                      {hasIssue && <AlertCircle className="w-3 h-3 text-amber-v shrink-0" />}
                      <p className="text-xs font-semibold text-t1">{cat}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-t3">{catItems.length} items</span>
                      <span className="text-xs font-bold text-t2">{formatCurrency(catValue)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
