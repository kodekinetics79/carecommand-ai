import { useState } from 'react';
import { Phone, MessageSquare, Mail, Sparkles, Clock, CheckCircle2, AlertCircle, ArrowRight, Bot, Zap, User, Calendar } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ModuleTabs from '../components/ui/ModuleTabs';

const channelTabs = [
  { id: 'all', label: 'All Channels', count: 42 },
  { id: 'phone', label: 'Phone', count: 18 },
  { id: 'whatsapp', label: 'WhatsApp', count: 14 },
  { id: 'sms', label: 'SMS', count: 6 },
  { id: 'email', label: 'Email', count: 4 },
];

const conversations = [
  { id: 'c1', name: 'Rebecca Walsh', channel: 'whatsapp', message: "Hi, I'd like to book a skin consultation this week", time: '2 min ago', status: 'unread', aiHandled: true, intent: 'Booking inquiry', suggestedSlot: 'Wed 28 May, 10:30am', value: '£320' },
  { id: 'c2', name: 'Kevin Addo', channel: 'phone', message: 'Missed call — AI follow-up sent via SMS', time: '14 min ago', status: 'ai-recovered', aiHandled: true, intent: 'Missed call recovery', suggestedSlot: 'Thu 29 May, 2:00pm', value: '£180' },
  { id: 'c3', name: 'Lara Petrov', channel: 'email', message: 'Can I reschedule my Botox appointment?', time: '28 min ago', status: 'replied', aiHandled: false, intent: 'Reschedule', suggestedSlot: 'Fri 30 May, 11:00am', value: '£480' },
  { id: 'c4', name: 'Michael Owusu', channel: 'whatsapp', message: 'What are your weekend availability hours?', time: '45 min ago', status: 'pending', aiHandled: true, intent: 'Availability enquiry', suggestedSlot: 'Sat 31 May, 9:00am', value: '£150' },
  { id: 'c5', name: 'Chloe Bennett', channel: 'sms', message: 'Missed call — 3rd attempt. Escalate to manager.', time: '1 hr ago', status: 'escalated', aiHandled: false, intent: 'Escalation needed', suggestedSlot: null, value: '£240' },
  { id: 'c6', name: 'Paul Nguyen', channel: 'email', message: 'Do you offer a family discount on wellness packages?', time: '2 hr ago', status: 'replied', aiHandled: true, intent: 'Pricing inquiry', suggestedSlot: 'Mon 2 Jun, 9:30am', value: '£580' },
  { id: 'c7', name: 'Harriet Cole', channel: 'whatsapp', message: 'I saw your offer on Instagram. Are there slots this week?', time: '2 hr ago', status: 'unread', aiHandled: true, intent: 'Booking inquiry', suggestedSlot: 'Wed 28 May, 3:00pm', value: '£290' },
];

const missedCallTimeline = [
  { time: '08:42', name: 'Anna Ivanova', recovered: true, method: 'WhatsApp AI', outcome: 'Booked Thu 2pm', value: '£420' },
  { time: '10:15', name: 'Chris Adewale', recovered: true, method: 'SMS AI', outcome: 'Booked Fri 11am', value: '£180' },
  { time: '12:07', name: 'James Kalu', recovered: false, method: 'No consent', outcome: 'Pending manual review', value: '£240' },
  { time: '13:55', name: 'Unknown Caller', recovered: false, method: 'No ID', outcome: 'Lead lost', value: '—' },
  { time: '15:30', name: 'Maya Singh', recovered: true, method: 'Email AI', outcome: 'Booked Mon 9am', value: '£580' },
];

const channelIcon: Record<string, React.ReactNode> = {
  whatsapp: <MessageSquare className="w-3.5 h-3.5 text-emerald-600" />,
  phone: <Phone className="w-3.5 h-3.5 text-blue-600" />,
  sms: <MessageSquare className="w-3.5 h-3.5 text-violet-600" />,
  email: <Mail className="w-3.5 h-3.5 text-amber-600" />,
};

const channelBg: Record<string, string> = {
  whatsapp: 'bg-emerald-50 border-emerald-200',
  phone: 'bg-blue-50 border-blue-200',
  sms: 'bg-violet-50 border-violet-200',
  email: 'bg-amber-50 border-amber-200',
};

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  unread: { label: 'Unread', color: 'text-blue-700', bg: 'bg-blue-100' },
  'ai-recovered': { label: 'AI Recovered', color: 'text-emerald-700', bg: 'bg-emerald-100' },
  replied: { label: 'Replied', color: 'text-slate-600', bg: 'bg-slate-100' },
  pending: { label: 'Pending', color: 'text-amber-700', bg: 'bg-amber-100' },
  escalated: { label: 'Escalate', color: 'text-red-700', bg: 'bg-red-100' },
};

const afterHoursData = [3, 2, 4, 1, 5, 2, 1];
const afterHoursHeights = ['h-[60%]', 'h-[40%]', 'h-[75%]', 'h-[30%]', 'h-[90%]', 'h-[45%]', 'h-[20%]'];

export default function AIReceptionist() {
  const [activeChannel, setActiveChannel] = useState('all');
  const [selectedConv, setSelectedConv] = useState(conversations[0]);

  const filtered = activeChannel === 'all' ? conversations : conversations.filter(c => c.channel === activeChannel);
  const recovered = missedCallTimeline.filter(c => c.recovered).length;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="AI Front Desk"
        subtitle="Intelligent conversation inbox, missed-call recovery, and after-hours automation."
        badge="7 Unread"
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:opacity-90 transition">
            <Bot className="w-4 h-4" /> CareDesk AI Settings
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Missed Calls Today" value="7" subtitle="Across all branches" icon={<Phone className="w-4 h-4" />} accent="red" />
        <StatCard title="AI Recovered" value={`${recovered}/5`} subtitle="Automated follow-up" trend={48} icon={<Bot className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Avg Response Time" value="1.9 min" subtitle="AI + human combined" trend={-22} icon={<Clock className="w-4 h-4" />} accent="blue" />
        <StatCard title="After-Hours Bookings" value="12" subtitle="This week via AI" trend={31} icon={<Calendar className="w-4 h-4" />} accent="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 pt-4 pb-3 border-b border-slate-100">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">Conversation Inbox</p>
                  <h3 className="text-sm font-bold text-slate-900">All incoming enquiries</h3>
                </div>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> AI Active
                </span>
              </div>
              <ModuleTabs tabs={channelTabs} activeTab={activeChannel} onChange={setActiveChannel} variant="pills" />
            </div>
            <div className="divide-y divide-slate-50">
              {filtered.map((conv) => {
                const status = statusConfig[conv.status] ?? statusConfig['pending'];
                const isSelected = selectedConv.id === conv.id;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => setSelectedConv(conv)}
                    className={`w-full flex items-start gap-3 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors ${isSelected ? 'bg-blue-50/50 border-l-2 border-l-blue-500' : ''}`}
                  >
                    <div className={`w-8 h-8 rounded-xl border flex items-center justify-center shrink-0 ${channelBg[conv.channel] ?? 'bg-slate-50 border-slate-200'}`}>
                      {channelIcon[conv.channel]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-900">{conv.name}</p>
                        <span className="text-[10px] text-slate-400 shrink-0">{conv.time}</span>
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-0.5">{conv.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${status.bg} ${status.color}`}>{status.label}</span>
                        {conv.aiHandled && <span className="text-[10px] font-semibold text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full">AI handled</span>}
                        <span className="text-[10px] font-bold text-emerald-700 ml-auto">{conv.value}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <BentoCard title="AI Conversation Summary" subtitle="Smart context panel" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                  {selectedConv.name.split(' ').map(n => n[0]).join('')}
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-900">{selectedConv.name}</p>
                  <p className="text-xs text-slate-400 capitalize">{selectedConv.channel} · {selectedConv.time}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2.5 rounded-xl bg-blue-50 border border-blue-100">
                  <p className="text-[10px] font-bold text-blue-500 uppercase tracking-wide mb-0.5">Intent</p>
                  <p className="text-xs font-semibold text-blue-900">{selectedConv.intent}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-100">
                  <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-wide mb-0.5">Est. Value</p>
                  <p className="text-xs font-bold text-emerald-700">{selectedConv.value}</p>
                </div>
              </div>
              {selectedConv.suggestedSlot && (
                <div className="p-3 rounded-xl border border-violet-200 bg-violet-50">
                  <div className="flex items-center gap-2 mb-1">
                    <Calendar className="w-3.5 h-3.5 text-violet-600" />
                    <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wide">AI Suggested Slot</p>
                  </div>
                  <p className="text-sm font-bold text-violet-900">{selectedConv.suggestedSlot}</p>
                  <button type="button" className="mt-2 w-full py-1.5 rounded-lg bg-violet-600 text-white text-xs font-semibold hover:bg-violet-700 transition-colors">
                    Confirm & Book
                  </button>
                </div>
              )}
              <div className="space-y-1.5">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Suggested Reply</p>
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 leading-relaxed">
                  "Hi {selectedConv.name.split(' ')[0]}, thanks for reaching out! We have availability {selectedConv.suggestedSlot ?? 'this week'}. Would that work? Reply YES to confirm."
                </div>
                <button type="button" className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-blue-300 text-xs font-semibold text-blue-600 hover:bg-blue-50 transition-colors">
                  <Zap className="w-3 h-3" /> Send AI Reply
                </button>
              </div>
            </div>
          </BentoCard>

          <BentoCard title="Missed-Call Recovery" subtitle="Today's call log" headerRight={
            <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-200">{recovered}/{missedCallTimeline.length} recovered</span>
          }>
            <div className="space-y-3">
              {missedCallTimeline.map((call, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${call.recovered ? 'bg-emerald-100' : 'bg-red-100'}`}>
                      {call.recovered ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <AlertCircle className="w-3.5 h-3.5 text-red-500" />}
                    </div>
                    {i < missedCallTimeline.length - 1 && <div className="w-px h-4 bg-slate-200" />}
                  </div>
                  <div className="flex-1 min-w-0 pb-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold text-slate-400">{call.time}</span>
                        <User className="w-3 h-3 text-slate-400" />
                        <p className="text-xs font-semibold text-slate-900">{call.name}</p>
                      </div>
                      {call.value !== '—' && <span className="text-[10px] font-bold text-emerald-700">{call.value}</span>}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`text-[10px] font-semibold ${call.recovered ? 'text-emerald-600' : 'text-red-500'}`}>{call.method}</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-[10px] text-slate-400">{call.outcome}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-slate-300 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors">
              <ArrowRight className="w-3 h-3" /> View full call log
            </button>
          </BentoCard>

          <BentoCard title="After-Hours Bookings" subtitle="AI automation — this week">
            <div className="grid grid-cols-7 gap-1 mb-2 items-end">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <div key={i} className="text-center">
                  <p className="text-[9px] text-slate-400 mb-1">{d}</p>
                  <div className="h-12 bg-slate-50 rounded-md overflow-hidden flex items-end">
                    <div className={`w-full bg-blue-500 rounded-sm ${afterHoursHeights[i]}`} />
                  </div>
                  <p className="text-[9px] text-slate-500 mt-1">{afterHoursData[i]}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500 text-center">18 bookings captured after-hours · £3,840 revenue</p>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
