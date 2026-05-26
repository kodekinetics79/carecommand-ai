import { Search, Bell, Sparkles, ChevronDown, Building2, X, Command } from 'lucide-react';
import { useState } from 'react';
import { branches } from '../../data/mockClinics';
import CommandPalette from '../ui/CommandPalette';

export default function Topbar() {
  const [selectedBranch, setSelectedBranch] = useState('All Branches');
  const [showBriefing, setShowBriefing] = useState(false);
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const branchOptions = ['All Branches', ...branches.map(b => b.name)];

  return (
    <>
      <header className="fixed top-0 left-[280px] right-0 h-14 bg-white/95 backdrop-blur-sm border-b border-slate-200/80 flex items-center px-5 gap-4 z-40 shadow-sm shadow-slate-900/[0.03]">
        {/* Search */}
        <div className="flex-1 max-w-sm relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            onFocus={() => setShowCommandPalette(true)}
            readOnly
            className="w-full pl-9 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none cursor-pointer hover:bg-slate-100 transition-colors placeholder:text-slate-400"
            placeholder="Search or ⌘K for commands..."
          />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* Command Palette button */}
          <button
            type="button"
            onClick={() => setShowCommandPalette(true)}
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-colors"
          >
            <Command className="w-3 h-3" />
            <kbd className="font-medium">⌘K</kbd>
          </button>

          {/* Branch Switcher */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setShowBranchMenu(!showBranchMenu); setShowNotifications(false); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-200 rounded-xl hover:bg-slate-50 hover:border-slate-300 transition-colors"
            >
              <Building2 className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-slate-700 font-medium max-w-[130px] truncate text-xs">{selectedBranch}</span>
              <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform ${showBranchMenu ? 'rotate-180' : ''}`} />
            </button>
            {showBranchMenu && (
              <div className="absolute top-full mt-1.5 right-0 bg-white border border-slate-200 rounded-2xl shadow-xl shadow-slate-900/10 py-1.5 min-w-[210px] z-50">
                <p className="px-4 pt-1 pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Location</p>
                {branchOptions.map(b => (
                  <button
                    type="button"
                    key={b}
                    onClick={() => { setSelectedBranch(b); setShowBranchMenu(false); }}
                    className={`w-full text-left px-4 py-2 text-sm hover:bg-slate-50 transition-colors flex items-center gap-2.5 ${selectedBranch === b ? 'text-blue-600 font-semibold' : 'text-slate-700'}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${selectedBranch === b ? 'bg-blue-500' : 'bg-slate-300'}`} />
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* AI Briefing */}
          <button
            type="button"
            onClick={() => { setShowBriefing(true); setShowNotifications(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gradient-to-r from-blue-600 to-violet-600 text-white rounded-xl font-semibold hover:opacity-90 transition-opacity shadow-md shadow-blue-500/20"
          >
            <Sparkles className="w-3.5 h-3.5" />
            AI Briefing
          </button>

          {/* Notifications */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setShowNotifications(!showNotifications); setShowBranchMenu(false); }}
              title="Notifications"
              aria-label="Notifications"
              className="relative w-8 h-8 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors"
            >
              <Bell className="w-4 h-4 text-slate-600" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white" />
            </button>
            {showNotifications && (
              <div className="absolute top-full mt-1.5 right-0 bg-white border border-slate-200 rounded-2xl shadow-xl shadow-slate-900/10 py-2 w-[340px] z-50">
                <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between">
                  <p className="text-sm font-bold text-slate-900">Notifications</p>
                  <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">5 new</span>
                </div>
                {notifications.map((n) => (
                  <div key={n.id} className="px-4 py-3 hover:bg-slate-50 transition-colors cursor-pointer border-b border-slate-50 last:border-0">
                    <div className="flex items-start gap-3">
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.urgent ? 'bg-red-500' : 'bg-blue-500'}`} />
                      <div>
                        <p className="text-xs font-semibold text-slate-900">{n.title}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{n.body}</p>
                        <p className="text-[10px] text-slate-400 mt-1">{n.time}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Avatar */}
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-white text-xs font-bold cursor-pointer shadow-md shadow-blue-500/20 hover:opacity-90 transition-opacity">
            KK
          </div>
        </div>
      </header>

      {/* AI Briefing Drawer */}
      {showBriefing && (
        <div className="fixed inset-0 z-50 flex items-start justify-end pt-14">
          <div className="absolute inset-0 bg-slate-950/30 backdrop-blur-sm" onClick={() => setShowBriefing(false)} />
          <div className="relative bg-white w-[440px] h-[calc(100vh-56px)] shadow-2xl border-l border-slate-200 flex flex-col animate-slide-right">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-md shadow-blue-500/20">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-900">AI Daily Briefing</div>
                  <div className="text-xs text-slate-400">Monday, 26 May 2026 · All Branches</div>
                </div>
              </div>
              <button type="button" onClick={() => setShowBriefing(false)} title="Close briefing" aria-label="Close briefing" className="w-7 h-7 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            {/* Summary bar */}
            <div className="px-5 py-3 bg-gradient-to-r from-blue-600 to-violet-600">
              <p className="text-xs font-semibold text-blue-100 uppercase tracking-widest mb-1">Today's growth opportunity</p>
              <p className="text-white font-bold text-sm leading-snug">£28,350 in recoverable revenue across 5 active signals. 3 actions need your attention.</p>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {briefingItems.map((item, i) => (
                <div key={i} className={`p-4 rounded-2xl border ${item.urgent ? 'border-red-100 bg-red-50/60' : 'border-slate-100 bg-slate-50'}`}>
                  <div className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${item.color}`}>{item.category}</div>
                  <div className="text-sm text-slate-800 leading-relaxed">{item.text}</div>
                  {item.action && (
                    <button type="button" className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1">
                      {item.action} →
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
    </>
  );
}

const notifications = [
  { id: 1, title: '42 missed calls — 23 still uncontacted', body: 'AI follow-up sent to 19. Manual review needed.', time: '2 min ago', urgent: true },
  { id: 2, title: 'Westside utilisation dropped to 61%', body: '31 empty slots this week. Recommend campaign.', time: '18 min ago', urgent: false },
  { id: 3, title: 'Botox stock at critical level', body: 'Downtown branch: 3 units left, 8 appointments next week.', time: '1 hr ago', urgent: true },
  { id: 4, title: 'New 90-day campaign bookings: 38', body: 'Revenue attributed: £7,600 from 187 contacts.', time: '2 hr ago', urgent: false },
  { id: 5, title: 'Dr. Mitchell review campaign ready', body: '89 consultations eligible. Launch when ready.', time: '3 hr ago', urgent: false },
];

const briefingItems = [
  { category: 'Revenue Opportunity', color: 'text-emerald-600', urgent: false, action: 'View RevenuePulse →',
    text: "Today's confirmed appointment value is £8,640 across all branches. Automation has already recovered £1,240 in no-show risk through early reminders." },
  { category: 'Attention Needed', color: 'text-red-500', urgent: true, action: 'Review scheduling →',
    text: '3 high-risk appointments flagged today: Marcus Thompson (74% no-show risk), Mohammed Al-Farsi (61%), Yuki Tanaka (78%). AI reminders sent.' },
  { category: 'Operations', color: 'text-blue-600', urgent: false, action: 'Activate campaign →',
    text: 'Westside branch at 61% utilisation with 31 empty slots. Recommend activating a targeted offer for this week\'s available times.' },
  { category: 'Campaign Performance', color: 'text-violet-600', urgent: false, action: 'View Campaigner →',
    text: '90-Day Winback campaign: 38 bookings from 187 contacts (20.3% conversion). Revenue attributed: £7,600.' },
  { category: 'Staff Alert', color: 'text-amber-600', urgent: false, action: 'View staff workflow →',
    text: 'Jake Williams at Westside has the highest missed-call rate (14 this month) and lowest booking conversion (49%). Coaching recommended.' },
  { category: 'Inventory', color: 'text-orange-600', urgent: true, action: 'View inventory →',
    text: 'Botox stock at Downtown is below threshold for next week\'s schedule. Place reorder with Allergan UK today.' },
];
