import type { ReactNode } from 'react';
import { Layers, Flame, Trophy, Target, TrendingDown, Users, PhoneMissed, RotateCcw, Megaphone, Building2 } from 'lucide-react';
import PremiumMetricCard, { type MetricAccent } from '../dashboard/PremiumMetricCard';
import { formatCurrency } from '../../utils/formatters';
import type { CommandMetrics } from '../../lib/crmService';

// Command-view KPIs. Every figure is a tenant-wide database aggregate, and every
// threshold in the copy below is the value the server actually used — the strip
// used to claim "Rule-based score ≥ 70" whatever the tenant had configured.
//
// A metric the server could not compute renders as an absence with its reason,
// not as a zero. "Win rate 0%" and "no lead has been won or lost yet" are
// different statements about a clinic and only one of them is true.

const percent = (n: number) => `${Math.round(n)}%`;

export default function CRMMetricsStrip({ m, onNavigate }: { m: CommandMetrics; onNavigate: (route: string) => void }) {
  const { metrics, unavailable, policy, basis, scope } = m;
  const scoped = scope.patients === 'assigned_branch';

  const card = (
    key: keyof CommandMetrics['metrics'],
    props: { label: string; subtitle: string; icon: ReactNode; accent: MetricAccent; format?: (n: number) => string; primary?: boolean; onClick?: () => void },
  ) => {
    const value = metrics[key];
    if (value === null) return <UnavailableMetric key={key} label={props.label} icon={props.icon} accent={props.accent} reason={unavailable[key]} />;
    return <PremiumMetricCard key={key} {...props} value={value} />;
  };

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] text-t3">
        {scoped
          ? `Patient figures cover every patient in your assigned branch. ${scope.note}`
          : `Every figure covers all ${basis.patientCount.toLocaleString()} patients and ${basis.leadCount.toLocaleString()} leads in this workspace — not a sample.`}
        {basis.unscoredLeadCount > 0 && ` ${basis.unscoredLeadCount} lead${basis.unscoredLeadCount === 1 ? ' has a stage' : 's have a stage'} the priority heuristic does not recognise and ${basis.unscoredLeadCount === 1 ? 'is' : 'are'} left unscored.`}
      </p>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {card('openPipeline', { primary: true, label: 'Open pipeline', format: formatCurrency, subtitle: `${basis.openLeadCount.toLocaleString()} active deals`, icon: <Layers className="w-4 h-4" />, accent: 'emerald' })}
        {card('hotLeads', { label: 'Priority leads', subtitle: `Rule-based score ≥ ${policy.hotLeadScore}`, icon: <Flame className="w-4 h-4" />, accent: 'red' })}
        {card('winRate', { label: 'Win rate', format: percent, subtitle: `Retained vs lost across ${basis.closedLeadCount.toLocaleString()} closed leads`, icon: <Trophy className="w-4 h-4" />, accent: 'violet' })}
        {card('avgDeal', { label: 'Avg deal size', format: formatCurrency, subtitle: 'Per open lead, all leads', icon: <Target className="w-4 h-4" />, accent: 'blue' })}
        {card('avgChurnRisk', { label: 'Avg churn risk', format: percent, subtitle: `Across all ${basis.patientCount.toLocaleString()} patients`, icon: <TrendingDown className="w-4 h-4" />, accent: 'amber' })}
        {card('avgLtv', { label: 'Avg LTV per patient', format: formatCurrency, subtitle: `Across all ${basis.patientCount.toLocaleString()} patients`, icon: <Users className="w-4 h-4" />, accent: 'cyan', onClick: () => onNavigate('/patients') })}
        {card('missedCallValue', { label: 'Missed-call value', format: formatCurrency, subtitle: 'Uncontacted callers', icon: <PhoneMissed className="w-4 h-4" />, accent: 'red', onClick: () => onNavigate('/ai-receptionist') })}
        {card('inactiveRecoverable', {
          label: 'Inactive planning value', format: formatCurrency,
          subtitle: `Unvalidated ${policy.recoverableLtvPercent}% LTV assumption over ${basis.inactivePatientCount.toLocaleString()} patients`,
          icon: <RotateCcw className="w-4 h-4" />, accent: 'indigo',
        })}
        {metrics.campaignRoi != null && <PremiumMetricCard label="Campaign ROI" value={metrics.campaignRoi} format={n => `${Math.round(n)}×`} subtitle="Blended" icon={<Megaphone className="w-4 h-4" />} accent="violet" onClick={() => onNavigate('/campaigner')} />}
      </div>

      {scoped && (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-t3">
          <Building2 className="w-3 h-3" aria-hidden="true" /> Lead figures are tenant-wide: a lead record carries no branch.
        </p>
      )}
    </div>
  );
}

/**
 * A metric the server declined to compute. It shows the absence and the server's
 * own explanation — the alternative is a zero that reads as a measurement.
 */
function UnavailableMetric({ label, icon, accent, reason }: { label: string; icon: ReactNode; accent: MetricAccent; reason?: string }) {
  return (
    <div className="metric-card p-3.5">
      <div className={`stat-icon stat-icon-${accent}`}>{icon}</div>
      <p className="text-xl font-bold text-t3 tracking-tight tabular-nums mt-2" aria-label={`${label} unavailable`}>—</p>
      <p className="text-[12px] font-semibold text-t2 mt-0.5">{label}</p>
      <p className="text-[11px] text-t3 mt-0.5">{reason ?? 'Not available for this workspace.'}</p>
    </div>
  );
}
