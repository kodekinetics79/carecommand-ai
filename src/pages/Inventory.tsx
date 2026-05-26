import { Package, AlertCircle, Clock, Zap, Sparkles, ArrowRight, TrendingUp } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { inventoryItems } from '../data/mockInventory';
import { branches } from '../data/mockClinics';

const statusConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
  ok:       { label: 'In Stock',  color: 'text-emerald-700', bg: 'bg-emerald-100', border: 'border-emerald-200' },
  low:      { label: 'Low Stock', color: 'text-amber-700',   bg: 'bg-amber-100',   border: 'border-amber-200' },
  critical: { label: 'Critical',  color: 'text-red-700',     bg: 'bg-red-100',     border: 'border-red-200' },
  expiring: { label: 'Expiring',  color: 'text-orange-700',  bg: 'bg-orange-100',  border: 'border-orange-200' },
};

const criticalCount = inventoryItems.filter(i => i.status === 'critical' || i.status === 'low').length;
const expiringCount = inventoryItems.filter(i => i.status === 'expiring').length;
const totalValue = inventoryItems.reduce((s, i) => s + i.currentStock * i.unitCost, 0);

const aiRecommendations = [
  { title: 'Reorder Botox immediately', desc: 'Downtown: 3 vials left, 8 appointments next week. 2-day lead time.', urgency: 'Critical', action: 'Place reorder with Allergan UK' },
  { title: 'Use expiring composite resin first', desc: 'Northgate: expires 15 Jun. Prioritise dental fillings to avoid waste.', urgency: 'Expiring', action: 'Schedule usage priority' },
  { title: 'Transfer blood test strips from Downtown', desc: 'Southbank is critically low. Downtown has surplus.', urgency: 'Critical', action: 'Arrange branch transfer' },
];

export default function Inventory() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Inventory Intelligence"
        subtitle="Stock levels, expiry risk, reorder alerts, and AI supply recommendations across all branches."
        badge={`${criticalCount + expiringCount} Alerts`}
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition shadow-md shadow-blue-500/20">
            <Zap className="w-4 h-4" /> Place All Reorders
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Items Tracked" value={inventoryItems.length} subtitle="Across all branches" icon={<Package className="w-4 h-4" />} accent="blue" />
        <StatCard title="Critical / Low Stock" value={criticalCount} subtitle="Needs reorder now" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Expiring Soon" value={expiringCount} subtitle="Within 30 days" icon={<Clock className="w-4 h-4" />} accent="amber" />
        <StatCard title="Inventory Value" value={`£${totalValue.toLocaleString()}`} subtitle="Current stock value" icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Inventory table */}
        <BentoCard title="Stock Level Dashboard" subtitle="All items across branches">
          <div className="space-y-2.5">
            {inventoryItems.map((item) => {
              const sc = statusConfig[item.status];
              const branch = branches.find(b => b.id === item.branchId);
              const stockPct = Math.min(100, Math.round((item.currentStock / (item.reorderLevel * 2)) * 100));
              const weeksLeft = Math.round(item.currentStock / Math.max(item.usagePerWeek, 0.1));
              return (
                <div key={item.id} className={`p-4 rounded-2xl border transition-all hover:shadow-sm ${
                  item.status === 'critical' ? 'border-red-200 bg-red-50/40' :
                  item.status === 'expiring' ? 'border-orange-200 bg-orange-50/30' :
                  item.status === 'low' ? 'border-amber-200 bg-amber-50/20' :
                  'border-slate-200'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-slate-900">{item.name}</p>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg} ${sc.color}`}>{sc.label}</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">{item.category} · {branch?.name.split(' ')[0]} · Supplier: {item.supplier}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-slate-900">{item.currentStock} {item.unit}</p>
                      <p className="text-[10px] text-slate-400">Reorder at {item.reorderLevel}</p>
                    </div>
                  </div>

                  <div className="mb-2">
                    <ProgressBar value={stockPct} color={item.status === 'critical' ? 'red' : item.status === 'low' ? 'amber' : item.status === 'expiring' ? 'amber' : 'emerald'} />
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-[11px] text-slate-400">
                      <span>~{weeksLeft}w left</span>
                      {item.expiryDate && <span className={`font-semibold ${new Date(item.expiryDate) < new Date('2025-07-01') ? 'text-orange-600' : 'text-slate-400'}`}>Exp: {item.expiryDate}</span>}
                      <span>£{item.unitCost}/unit</span>
                    </div>
                    {(item.status === 'critical' || item.status === 'low') && (
                      <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg hover:bg-blue-100 transition-colors">
                        <Zap className="w-3 h-3" /> Reorder now
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
                <div key={rec.title} className="p-3.5 rounded-xl border border-slate-200 hover:border-blue-200 hover:shadow-sm transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold text-slate-900 leading-tight">{rec.title}</p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${rec.urgency === 'Critical' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>{rec.urgency}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 mb-2">{rec.desc}</p>
                  <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
                    <ArrowRight className="w-3 h-3" /> {rec.action}
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Category Breakdown" subtitle="Stock by category">
            <div className="space-y-2.5">
              {['Aesthetics', 'Dental', 'Diagnostics', 'Dermatology', 'Physiotherapy', 'General'].map(cat => {
                const catItems = inventoryItems.filter(i => i.category === cat);
                const catValue = catItems.reduce((s, i) => s + i.currentStock * i.unitCost, 0);
                const hasIssue = catItems.some(i => i.status !== 'ok');
                return (
                  <div key={cat} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-2">
                      {hasIssue && <AlertCircle className="w-3 h-3 text-amber-500 shrink-0" />}
                      <p className="text-xs font-semibold text-slate-800">{cat}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400">{catItems.length} items</span>
                      <span className="text-xs font-bold text-slate-700">£{catValue.toLocaleString()}</span>
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
