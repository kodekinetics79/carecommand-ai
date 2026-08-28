import { Layers, Flame, Trophy, Target, TrendingDown, Users, PhoneMissed, RotateCcw, Megaphone } from 'lucide-react';
import PremiumMetricCard from '../dashboard/PremiumMetricCard';
import { formatCurrency } from '../../utils/formatters';
import type { CommandMetrics } from '../../lib/crmService';

// Command-view KPIs. Uses patient terminology (Avg LTV per patient, etc.).
export default function CRMMetricsStrip({ m, onNavigate }: { m: CommandMetrics; onNavigate: (route: string) => void }) {
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <PremiumMetricCard primary label="Open pipeline" value={m.openPipeline} format={formatCurrency} subtitle="Active deals" icon={<Layers className="w-4 h-4" />} accent="emerald" />
      <PremiumMetricCard label="Priority leads" value={m.hotLeads} subtitle="Rule-based score ≥ 70" icon={<Flame className="w-4 h-4" />} accent="red" />
      <PremiumMetricCard label="Win rate" value={m.winRate} format={n => `${Math.round(n)}%`} subtitle="Retained vs lost" icon={<Trophy className="w-4 h-4" />} accent="violet" />
      <PremiumMetricCard label="Avg deal size" value={m.avgDeal} format={formatCurrency} subtitle="Per open lead" icon={<Target className="w-4 h-4" />} accent="blue" />
      <PremiumMetricCard label="Avg churn risk" value={m.avgChurnRisk} format={n => `${Math.round(n)}%`} subtitle="Across patients" icon={<TrendingDown className="w-4 h-4" />} accent="amber" />
      <PremiumMetricCard label="Avg LTV per patient" value={m.avgLtv} format={formatCurrency} subtitle="Lifetime value" icon={<Users className="w-4 h-4" />} accent="cyan" onClick={() => onNavigate('/patients')} />
      <PremiumMetricCard label="Missed-call value" value={m.missedCallValue} format={formatCurrency} subtitle="Uncontacted callers" icon={<PhoneMissed className="w-4 h-4" />} accent="red" onClick={() => onNavigate('/ai-receptionist')} />
      <PremiumMetricCard label="Inactive planning value" value={m.inactiveRecoverable} format={formatCurrency} subtitle="Unvalidated 30% LTV assumption" icon={<RotateCcw className="w-4 h-4" />} accent="indigo" />
      {m.campaignRoi != null && <PremiumMetricCard label="Campaign ROI" value={m.campaignRoi} format={n => `${Math.round(n)}×`} subtitle="Blended" icon={<Megaphone className="w-4 h-4" />} accent="violet" onClick={() => onNavigate('/campaigner')} />}
    </div>
  );
}
