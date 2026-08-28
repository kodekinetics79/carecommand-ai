import { Package, AlertCircle, Clock, TrendingUp } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { useApiResource } from '../hooks/useApiResource';
import { mapInventoryItem, type ApiInventoryItem } from '../lib/apiAdapters';
import { formatCurrency } from '../utils/formatters';

interface ApiBranchOption { id: string; name: string }

const statusConfig: Record<string, { label: string; badge: string; border: string; bg: string }> = {
  ok:       { label: 'In Stock',  badge: 'badge badge-emerald', border: 'border-[var(--b1)]',        bg: 'bg-[var(--s2)]' },
  low:      { label: 'Low Stock', badge: 'badge badge-amber',   border: 'border-[var(--b1)]',        bg: 'bg-[var(--amber-soft)]' },
  critical: { label: 'Critical',  badge: 'badge badge-red',     border: 'border-[var(--b1)]',        bg: 'bg-[var(--red-soft)]' },
  expiring: { label: 'Expiring',  badge: 'badge badge-amber',   border: 'border-[var(--b1)]',        bg: 'bg-[var(--amber-soft)]' },
};

export default function Inventory() {
  const { data: stockItems, source, error } = useApiResource<ApiInventoryItem, ReturnType<typeof mapInventoryItem>>('/v1/inventory?limit=100', [], mapInventoryItem);
  const { data: branchOptions } = useApiResource<ApiBranchOption, ApiBranchOption>('/v1/branches?limit=100', [], row => row);
  const loadError = error;

  const criticalCount = stockItems.filter(i => i.status === 'critical' || i.status === 'low').length;
  const expiringCount = stockItems.filter(i => i.status === 'expiring').length;
  const totalValue = stockItems.reduce((sum, item) => sum + item.currentStock * item.unitCost, 0);
  const supplyRecommendations = stockItems
    .filter(item => item.status !== 'ok')
    .sort((left, right) => (left.status === 'critical' ? -1 : 0) - (right.status === 'critical' ? -1 : 0))
    .slice(0, 5);
  const inventoryCategories = [...new Set(stockItems.map(item => item.category))].sort();

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Inventory"
        subtitle="Review recorded stock levels, reorder thresholds, expiry dates, and items that need attention."
        badge={loadError ? 'Data unavailable' : source === 'live' ? `${criticalCount + expiringCount} alerts` : 'Loading inventory'}
        badgeColor={loadError ? 'red' : criticalCount + expiringCount > 0 ? 'amber' : 'blue'}
      />

      <div role="note" className="rounded-2xl border border-[var(--amber-soft)] bg-[var(--amber-soft)] px-4 py-3 text-xs text-amber-v">
        Purchasing is not configured in this workspace. Stock counts must only be updated after items are physically received and verified.
      </div>

      {loadError && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Inventory data is unavailable. {loadError}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Items tracked" value={stockItems.length} subtitle="Loaded records" icon={<Package className="w-4 h-4" />} accent="blue" />
        <StatCard title="Critical or low" value={criticalCount} subtitle="Below recorded threshold" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Expiring soon" value={expiringCount} subtitle="Based on stored dates" icon={<Clock className="w-4 h-4" />} accent="amber" />
        <StatCard title="Recorded value" value={formatCurrency(totalValue)} subtitle="Stock × stored unit cost" icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Inventory table */}
        <BentoCard title="Stock levels" subtitle="Recorded items across accessible branches">
          <div className="space-y-2.5">
            {stockItems.length === 0 && <p className="py-8 text-center text-sm text-t3">No inventory items are recorded for this workspace.</p>}
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
                      <span>Est. {weeksLeft} weeks at recorded use</span>
                      {item.expiryDate && <span className={`font-semibold ${item.status === 'expiring' ? 'text-amber-v' : 'text-t3'}`}>Exp: {item.expiryDate}</span>}
                      <span>{formatCurrency(item.unitCost)}/unit</span>
                    </div>
                    {(item.status === 'critical' || item.status === 'low') && <span className="text-[10px] font-semibold text-amber-v">Purchasing follow-up required</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>

        {/* Right sidebar */}
        <div className="space-y-4">
          <BentoCard title="Stock alerts" subtitle="Items outside stored stock or expiry thresholds" headerRight={<AlertCircle className="w-4 h-4 text-amber-v" />}>
            <div className="space-y-3">
              {supplyRecommendations.length === 0 && <p className="text-xs text-t3">No stock or expiry alerts are recorded.</p>}
              {supplyRecommendations.map((rec) => (
                <div key={rec.id} className="p-3.5 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold text-t1 leading-tight">{rec.name} needs attention</p>
                    <span className={`badge shrink-0 ${rec.status === 'critical' ? 'badge-red' : 'badge-amber'}`}>{statusConfig[rec.status]?.label ?? rec.status}</span>
                  </div>
                  <p className="text-[11px] text-t3 mb-2">{rec.currentStock} {rec.unit} available; reorder level is {rec.reorderLevel}.</p>
                  {(rec.status === 'critical' || rec.status === 'low') && <p className="text-[11px] font-semibold text-amber-v">Create a purchasing request in your approved external workflow.</p>}
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Category Breakdown" subtitle="Stock by category">
            <div className="space-y-2.5">
              {inventoryCategories.map(cat => {
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
