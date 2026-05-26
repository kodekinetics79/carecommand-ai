import type { Campaign } from '../../types';
import { formatCurrency } from '../../utils/formatters';
import { Sparkles, PlayCircle, PauseCircle, CheckCircle2, Clock } from 'lucide-react';

const statusConfig = {
  active: { icon: PlayCircle, color: 'text-emerald-600', bg: 'bg-emerald-50', label: 'Active' },
  paused: { icon: PauseCircle, color: 'text-amber-600', bg: 'bg-amber-50', label: 'Paused' },
  completed: { icon: CheckCircle2, color: 'text-slate-500', bg: 'bg-slate-100', label: 'Completed' },
  draft: { icon: Clock, color: 'text-blue-500', bg: 'bg-blue-50', label: 'Draft' },
  scheduled: { icon: Clock, color: 'text-violet-600', bg: 'bg-violet-50', label: 'Scheduled' },
};

const channelColors: Record<string, string> = {
  whatsapp: 'bg-green-100 text-green-700',
  sms: 'bg-blue-100 text-blue-700',
  email: 'bg-slate-100 text-slate-600',
  push: 'bg-violet-100 text-violet-700',
};

interface CampaignCardProps {
  campaign: Campaign;
}

export default function CampaignCard({ campaign }: CampaignCardProps) {
  const status = statusConfig[campaign.status];
  const openRate = campaign.sent > 0 ? Math.round((campaign.opened / campaign.sent) * 100) : 0;
  const bookRate = campaign.sent > 0 ? Math.round((campaign.booked / campaign.sent) * 100) : 0;
  const StatusIcon = status.icon;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0 pr-2">
          <div className="flex items-center gap-1.5 mb-1">
            {campaign.aiGenerated && (
              <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
            )}
            <h4 className="text-sm font-bold text-slate-900 truncate">{campaign.name}</h4>
          </div>
          <p className="text-xs text-slate-500">{campaign.goal}</p>
        </div>
        <div className={`flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full ${status.bg} ${status.color} shrink-0`}>
          <StatusIcon className="w-3 h-3" />
          {status.label}
        </div>
      </div>

      <div className="flex gap-1 mb-3">
        {campaign.channels.map(ch => (
          <span key={ch} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded capitalize ${channelColors[ch] || 'bg-slate-100 text-slate-600'}`}>
            {ch}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center mb-3">
        <div className="bg-slate-50 rounded-lg p-2">
          <div className="text-sm font-bold text-slate-900">{campaign.audienceSize}</div>
          <div className="text-[10px] text-slate-500">Audience</div>
        </div>
        <div className="bg-slate-50 rounded-lg p-2">
          <div className="text-sm font-bold text-blue-600">{openRate}%</div>
          <div className="text-[10px] text-slate-500">Opened</div>
        </div>
        <div className="bg-slate-50 rounded-lg p-2">
          <div className="text-sm font-bold text-emerald-600">{bookRate}%</div>
          <div className="text-[10px] text-slate-500">Booked</div>
        </div>
      </div>

      {campaign.revenue > 0 && (
        <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
          <span className="text-slate-500">Revenue attributed</span>
          <span className="font-bold text-emerald-600">{formatCurrency(campaign.revenue)}</span>
        </div>
      )}
    </div>
  );
}
