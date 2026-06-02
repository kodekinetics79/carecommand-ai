import { useMemo, useState } from 'react';
import { Phone, MessageSquare, Mail, Sparkles, Clock, CheckCircle2, AlertCircle, ArrowRight, Bot, Zap, User, Calendar } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ModuleTabs from '../components/ui/ModuleTabs';
import { useApiResource } from '../hooks/useApiResource';
import { apiRequest } from '../lib/api';
import { mapConversation, type ApiConversation } from '../lib/apiAdapters';

interface ConversationCard {
  id: string;
  name: string;
  channel: string;
  message: string;
  time: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  aiHandled: boolean;
  intent: string;
  suggestedSlot: string | null;
  value: string;
  lastAgentMessage?: string;
  lastAgentMessageAt?: string;
}

const fallbackConversations: ConversationCard[] = [
  { id: 'c1', name: 'Rebecca Walsh', channel: 'whatsapp', message: "Hi, I'd like to book a skin consultation this week", time: '2 min ago', createdAt: '2026-06-02T09:00:00.000Z', updatedAt: '2026-06-02T09:02:00.000Z', status: 'unread', aiHandled: true, intent: 'Booking inquiry', suggestedSlot: 'Wed 28 May, 10:30am', value: '£320', lastAgentMessage: 'We have a couple of openings later this week.', lastAgentMessageAt: '2026-06-02T09:01:00.000Z' },
  { id: 'c2', name: 'Kevin Addo', channel: 'call', message: 'Missed call — AI follow-up sent via SMS', time: '14 min ago', createdAt: '2026-06-02T08:35:00.000Z', updatedAt: '2026-06-02T08:49:00.000Z', status: 'ai-recovered', aiHandled: true, intent: 'Missed call recovery', suggestedSlot: 'Thu 29 May, 2:00pm', value: '£180', lastAgentMessage: 'Sorry we missed you — reply with a good time and we will call you back.', lastAgentMessageAt: '2026-06-02T08:48:00.000Z' },
  { id: 'c3', name: 'Lara Petrov', channel: 'email', message: 'Can I reschedule my Botox appointment?', time: '28 min ago', createdAt: '2026-06-02T08:00:00.000Z', updatedAt: '2026-06-02T08:28:00.000Z', status: 'replied', aiHandled: false, intent: 'Reschedule', suggestedSlot: 'Fri 30 May, 11:00am', value: '£480', lastAgentMessage: 'Yes — Friday at 11:00 is available if you want to move it.', lastAgentMessageAt: '2026-06-02T08:26:00.000Z' },
  { id: 'c4', name: 'Michael Owusu', channel: 'whatsapp', message: 'What are your weekend availability hours?', time: '45 min ago', createdAt: '2026-06-02T07:45:00.000Z', updatedAt: '2026-06-02T08:30:00.000Z', status: 'pending', aiHandled: true, intent: 'Availability enquiry', suggestedSlot: 'Sat 31 May, 9:00am', value: '£150', lastAgentMessage: 'Weekend slots are open Saturday morning and early afternoon.', lastAgentMessageAt: '2026-06-02T08:29:00.000Z' },
  { id: 'c5', name: 'Chloe Bennett', channel: 'sms', message: 'Missed call — 3rd attempt. Escalate to manager.', time: '1 hr ago', createdAt: '2026-06-02T07:00:00.000Z', updatedAt: '2026-06-02T08:00:00.000Z', status: 'escalated', aiHandled: false, intent: 'Escalation needed', suggestedSlot: null, value: '£240', lastAgentMessage: 'Escalated to the manager for a callback today.', lastAgentMessageAt: '2026-06-02T08:00:00.000Z' },
  { id: 'c6', name: 'Paul Nguyen', channel: 'email', message: 'Do you offer a family discount on wellness packages?', time: '2 hr ago', createdAt: '2026-06-02T06:00:00.000Z', updatedAt: '2026-06-02T08:00:00.000Z', status: 'replied', aiHandled: true, intent: 'Pricing inquiry', suggestedSlot: 'Mon 2 Jun, 9:30am', value: '£580', lastAgentMessage: 'I can share the current package options and family pricing.', lastAgentMessageAt: '2026-06-02T06:08:00.000Z' },
  { id: 'c7', name: 'Harriet Cole', channel: 'whatsapp', message: 'I saw your offer on Instagram. Are there slots this week?', time: '2 hr ago', createdAt: '2026-06-02T06:15:00.000Z', updatedAt: '2026-06-02T08:10:00.000Z', status: 'unread', aiHandled: true, intent: 'Booking inquiry', suggestedSlot: 'Wed 28 May, 3:00pm', value: '£290', lastAgentMessage: 'We have a few slots left this week — want me to hold one?', lastAgentMessageAt: '2026-06-02T06:18:00.000Z' },
];

const channelIcon: Record<string, React.ReactNode> = {
  whatsapp: <MessageSquare className="w-3.5 h-3.5 text-emerald-v" />,
  phone: <Phone className="w-3.5 h-3.5 text-indigo" />,
  call: <Phone className="w-3.5 h-3.5 text-indigo" />,
  sms: <MessageSquare className="w-3.5 h-3.5 text-violet-v" />,
  email: <Mail className="w-3.5 h-3.5 text-amber-v" />,
};

const channelBg: Record<string, string> = {
  whatsapp: 'bg-[var(--emerald-soft)] border-[var(--b1)]',
  phone: 'bg-[var(--blue-soft)] border-[var(--b1)]',
  call: 'bg-[var(--blue-soft)] border-[var(--b1)]',
  sms: 'bg-[var(--violet-soft)] border-[var(--b1)]',
  email: 'bg-[var(--amber-soft)] border-[var(--b1)]',
};

const statusConfig: Record<string, { label: string; badgeClass: string }> = {
  unread: { label: 'Unread', badgeClass: 'badge badge-blue' },
  'ai-recovered': { label: 'AI Recovered', badgeClass: 'badge badge-emerald' },
  replied: { label: 'Replied', badgeClass: 'badge badge-blue' },
  pending: { label: 'Pending', badgeClass: 'badge badge-amber' },
  escalated: { label: 'Escalate', badgeClass: 'badge badge-red' },
};

function buildReplyDraft(conversation?: ConversationCard) {
  if (!conversation) return '';
  const firstName = conversation.name.split(' ')[0];
  if (conversation.status === 'escalated') {
    return `Hi ${firstName}, thanks for your patience — I’ve escalated this to the manager and we’ll review it today.`;
  }
  if (conversation.channel === 'call') {
    return `Hi ${firstName}, sorry we missed your call. Reply with a good time and we’ll call you straight back.`;
  }
  return `Hi ${firstName}, thanks for reaching out — we can help with ${conversation.intent.toLowerCase()}. Would you like me to reserve the next available slot?`;
}

export default function AIReceptionist() {
  const [activeChannel, setActiveChannel] = useState('all');
  const [selectedId, setSelectedId] = useState<string>('');
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const { data: conversationRecords, source, reload } = useApiResource<ApiConversation, ConversationCard>(
    '/v1/conversations?limit=100',
    fallbackConversations,
    mapConversation,
  );
  const effectiveSelectedId = selectedId || conversationRecords[0]?.id || '';
  const selectedConv = conversationRecords.find(item => item.id === effectiveSelectedId) ?? conversationRecords[0];
  const replyPreview = buildReplyDraft(selectedConv);

  const channelTabs = useMemo(() => {
    const channels = ['all', 'call', 'whatsapp', 'sms', 'email'];
    return channels.map(channel => ({
      id: channel,
      label: channel === 'all' ? 'All Channels' : channel === 'call' ? 'Calls' : channel === 'sms' ? 'SMS' : channel === 'email' ? 'Email' : channel === 'whatsapp' ? 'WhatsApp' : channel,
      count: channel === 'all' ? conversationRecords.length : conversationRecords.filter(item => item.channel === channel).length,
    }));
  }, [conversationRecords]);

  const filtered = activeChannel === 'all' ? conversationRecords : conversationRecords.filter(item => item.channel === activeChannel);
  const callConversations = conversationRecords
    .filter(item => item.channel === 'call')
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const recovered = callConversations.filter(item => item.aiHandled || item.status === 'ai-recovered' || Boolean(item.lastAgentMessage)).length;
  const unresolved = conversationRecords.filter(item => !['replied', 'ai-recovered'].includes(item.status)).length;
  const avgReplyMinutes = useMemo(() => {
    const replyDurations = conversationRecords
      .filter(item => item.lastAgentMessageAt)
      .map(item => {
        const createdAt = new Date(item.createdAt).getTime();
        const repliedAt = new Date(item.lastAgentMessageAt as string).getTime();
        return Math.max(0, repliedAt - createdAt);
      });
    if (!replyDurations.length) return null;
    const averageMs = replyDurations.reduce((total, value) => total + value, 0) / replyDurations.length;
    return Math.max(1, Math.round(averageMs / 60000));
  }, [conversationRecords]);

  async function sendReply(status: 'replied' | 'escalated' = 'replied') {
    if (!selectedConv) return;
    const message = replyText.trim() || replyPreview;
    if (!message.trim()) return;
    setIsSending(true);
    setSendError(null);
    try {
      await apiRequest(`/v1/conversations/${selectedConv.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: message.trim(), status }),
      });
      await reload();
      setReplyText('');
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Failed to send reply');
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="AI Front Desk"
        subtitle="Live conversation inbox, missed-call recovery, and AI reply automation."
        badge={`Unread: ${unresolved} · ${source === 'live' ? 'Live DB' : 'Demo'}`}
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Bot className="w-4 h-4" /> CareDesk AI Settings
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Missed Calls Today" value={String(callConversations.length)} subtitle="Calls needing recovery" icon={<Phone className="w-4 h-4" />} accent="red" />
        <StatCard title="AI Recovered" value={`${recovered}/${callConversations.length || 1}`} subtitle="Missed-call follow-up" trend={48} icon={<Bot className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Avg Response Time" value={`${avgReplyMinutes ? `${avgReplyMinutes} min` : 'n/a'}`} subtitle="Time to first AI reply" trend={-22} icon={<Clock className="w-4 h-4" />} accent="blue" />
        <StatCard title="Open Conversations" value={String(unresolved)} subtitle="Needs review or action" trend={31} icon={<Calendar className="w-4 h-4" />} accent="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="bg-[var(--s2)] rounded-2xl border border-[var(--b1)] overflow-hidden">
            <div className="px-4 pt-4 pb-3 border-b border-[var(--b1)]">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-0.5">Conversation Inbox</p>
                  <h3 className="text-sm font-bold text-t1">All incoming enquiries</h3>
                </div>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-v bg-[var(--emerald-soft)] px-2.5 py-1 rounded-full border border-[var(--b1)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> AI Active
                </span>
              </div>
              <ModuleTabs tabs={channelTabs} activeTab={activeChannel} onChange={setActiveChannel} variant="pills" />
            </div>
            <div className="divide-y divide-[var(--b0)]">
              {filtered.map((conv) => {
                const status = statusConfig[conv.status] ?? statusConfig.pending;
                const isSelected = selectedConv?.id === conv.id;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(conv.id);
                      setReplyText('');
                    }}
                    className={`w-full flex items-start gap-3 px-4 py-3.5 text-left hover:bg-[var(--s3)] transition-colors ${isSelected ? 'bg-[var(--blue-soft)] border-l-2 border-l-indigo' : ''}`}
                  >
                    <div className={`w-8 h-8 rounded-xl border flex items-center justify-center shrink-0 ${channelBg[conv.channel] ?? 'bg-[var(--s3)] border-[var(--b1)]'}`}>
                      {channelIcon[conv.channel] ?? <MessageSquare className="w-3.5 h-3.5 text-t3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-t1">{conv.name}</p>
                        <span className="text-[10px] text-t3 shrink-0">{conv.time}</span>
                      </div>
                      <p className="text-xs text-t3 truncate mt-0.5">
                        {conv.message}
                        {conv.lastAgentMessage ? ` · AI: ${conv.lastAgentMessage}` : ''}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={status.badgeClass}>{status.label}</span>
                        {conv.aiHandled && <span className="badge badge-violet">AI handled</span>}
                        <span className="text-[10px] font-bold text-emerald-v ml-auto">{conv.value}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <BentoCard title="AI Conversation Summary" subtitle="Smart context panel" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
            {selectedConv ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                    {selectedConv.name.split(' ').map(name => name[0]).join('')}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-t1">{selectedConv.name}</p>
                    <p className="text-xs text-t3 capitalize">{selectedConv.channel} · {selectedConv.time}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2.5 rounded-xl bg-[var(--blue-soft)] border border-[var(--b1)]">
                    <p className="text-[10px] font-bold text-blue-v uppercase tracking-wide mb-0.5">Intent</p>
                    <p className="text-xs font-semibold text-t1">{selectedConv.intent}</p>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[var(--emerald-soft)] border border-[var(--b1)]">
                    <p className="text-[10px] font-bold text-emerald-v uppercase tracking-wide mb-0.5">Est. Value</p>
                    <p className="text-xs font-bold text-emerald-v">{selectedConv.value}</p>
                  </div>
                </div>
                {selectedConv.lastAgentMessage && (
                  <div className="p-3 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
                    <p className="text-[10px] font-bold text-t3 uppercase tracking-widest mb-1">Last AI Reply</p>
                    <p className="text-sm text-t1 leading-relaxed">{selectedConv.lastAgentMessage}</p>
                    {selectedConv.lastAgentMessageAt && <p className="text-[10px] text-t3 mt-1">{new Date(selectedConv.lastAgentMessageAt).toLocaleString()}</p>}
                  </div>
                )}
                {selectedConv.suggestedSlot && (
                  <div className="p-3 rounded-xl border border-[var(--b2)] bg-[var(--violet-soft)]">
                    <div className="flex items-center gap-2 mb-1">
                      <Calendar className="w-3.5 h-3.5 text-violet-v" />
                      <p className="text-[10px] font-bold text-violet-v uppercase tracking-wide">AI Suggested Slot</p>
                    </div>
                    <p className="text-sm font-bold text-t1">{selectedConv.suggestedSlot}</p>
                    <button type="button" className="mt-2 w-full py-1.5 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-colors">
                      Confirm & Book
                    </button>
                  </div>
                )}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-bold text-t3 uppercase tracking-widest">Draft Reply</p>
                  <textarea
                    key={selectedConv?.id ?? 'none'}
                    defaultValue={replyPreview}
                    onChange={event => setReplyText(event.target.value)}
                    rows={4}
                    className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t2 leading-relaxed outline-none focus:border-indigo"
                    placeholder="Write the AI reply"
                  />
                  {sendError && <p className="text-[11px] font-semibold text-red-v">{sendError}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isSending}
                      onClick={() => sendReply('replied')}
                      className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-[var(--b2)] text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition-colors disabled:opacity-60"
                    >
                      <Zap className="w-3 h-3" /> {isSending ? 'Sending…' : 'Send AI Reply'}
                    </button>
                    <button
                      type="button"
                      disabled={isSending}
                      onClick={() => sendReply('escalated')}
                      className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-[var(--b2)] text-xs font-semibold text-red-v hover:bg-[var(--red-soft)] transition-colors disabled:opacity-60"
                    >
                      <AlertCircle className="w-3 h-3" /> Escalate
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-t3">No conversation selected yet.</p>
            )}
          </BentoCard>

          <BentoCard title="Missed-Call Recovery" subtitle="Live call log" headerRight={
            <span className="text-xs font-bold text-emerald-v bg-[var(--emerald-soft)] px-2 py-1 rounded-full border border-[var(--b1)]">{recovered}/{callConversations.length || 1} recovered</span>
          }>
            <div className="space-y-3">
              {(callConversations.length ? callConversations : conversationRecords.slice(0, 5)).map((call, index) => {
                const recoveredCall = call.aiHandled || call.status === 'ai-recovered' || Boolean(call.lastAgentMessage);
                return (
                  <div key={call.id} className="flex items-start gap-3">
                    <div className="flex flex-col items-center gap-1">
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${recoveredCall ? 'bg-[var(--emerald-soft)]' : 'bg-[var(--red-soft)]'}`}>
                        {recoveredCall ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-v" /> : <AlertCircle className="w-3.5 h-3.5 text-red-v" />}
                      </div>
                      {index < (callConversations.length ? callConversations.length : conversationRecords.slice(0, 5).length) - 1 && <div className="w-px h-4 bg-[var(--b1)]" />}
                    </div>
                    <div className="flex-1 min-w-0 pb-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-t3">{new Date(call.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <User className="w-3 h-3 text-t3" />
                          <p className="text-xs font-semibold text-t1">{call.name}</p>
                        </div>
                        {call.value !== '—' && <span className="text-[10px] font-bold text-emerald-v">{call.value}</span>}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`text-[10px] font-semibold ${recoveredCall ? 'text-emerald-v' : 'text-red-v'}`}>{recoveredCall ? 'Recovered by AI' : 'Needs review'}</span>
                        <span className="text-t3">·</span>
                        <span className="text-[10px] text-t3">{call.lastAgentMessage ?? call.message}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <button type="button" className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-[var(--b2)] text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition-colors">
              <ArrowRight className="w-3 h-3" /> View full call log
            </button>
          </BentoCard>

          <BentoCard title="After-Hours Bookings" subtitle="AI automation — this week">
            <div className="grid grid-cols-7 gap-1 mb-2 items-end">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => {
                const heightClass = ['h-[60%]', 'h-[40%]', 'h-[75%]', 'h-[30%]', 'h-[90%]', 'h-[45%]', 'h-[20%]'][index];
                const count = [3, 2, 4, 1, 5, 2, 1][index];
                return (
                  <div key={`${day}-${index}`} className="text-center">
                    <p className="text-[9px] text-t3 mb-1">{day}</p>
                    <div className="h-12 bg-[var(--s3)] rounded-md overflow-hidden flex items-end">
                      <div className={`w-full bg-indigo rounded-sm ${heightClass}`} />
                    </div>
                    <p className="text-[9px] text-t2 mt-1">{count}</p>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-t2 text-center">Live AI recovery stream · automatically updates from the DB</p>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
