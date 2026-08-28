import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Phone, MessageSquare, Mail, Sparkles, Clock, CheckCircle2, AlertCircle, ArrowRight, Bot, Zap, User, Calendar } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ModuleTabs from '../components/ui/ModuleTabs';
import ConfirmationModal from '../components/workflow/ConfirmationModal';
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
  valueEvidence: string;
  lastAgentMessage?: string;
  lastAgentMessageAt?: string;
  replyReadiness: ApiConversation['replyReadiness'];
}

interface ConversationReplyResult {
  delivered?: boolean;
  accepted?: boolean;
  deliveryStatus: string;
  providerMode: string | null;
  message: string;
}

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
  'ai-recovered': { label: 'Legacy follow-up status', badgeClass: 'badge badge-amber' },
  replied: { label: 'Replied', badgeClass: 'badge badge-blue' },
  pending: { label: 'Pending', badgeClass: 'badge badge-amber' },
  escalated: { label: 'Escalate', badgeClass: 'badge badge-red' },
};

function buildReplyDraft(conversation?: ConversationCard) {
  if (!conversation) return '';
  const firstName = conversation.name.split(' ')[0];
  const sender = conversation.replyReadiness.senderIdentity;
  if (conversation.status === 'escalated') {
    return `Hi ${firstName}, this is ${sender}. Your message has been routed for staff review. A staff response is not yet confirmed.`;
  }
  if (conversation.channel === 'call') {
    return `Hi ${firstName}, this is ${sender}. We have a record of your call. Reply with a preferred time for clinic staff to review. A callback is not yet scheduled.`;
  }
  return `Hi ${firstName}, this is ${sender}. Thanks for reaching out about ${conversation.intent.toLowerCase()}. Would you like clinic staff to review a scheduling request?`;
}

function humanizeToken(value: string) {
  return value.replaceAll('_', ' ').replace(/^\w/, character => character.toUpperCase());
}

export default function AIReceptionist() {
  const navigate = useNavigate();
  const [activeChannel, setActiveChannel] = useState('all');
  const [selectedId, setSelectedId] = useState<string>('');
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [confirmReplyOpen, setConfirmReplyOpen] = useState(false);
  const [clientAttemptKey, setClientAttemptKey] = useState('');
  const { data: conversationRecords, source, error, reload } = useApiResource<ApiConversation, ReturnType<typeof mapConversation>>(
    '/v1/conversations?limit=100',
    [],
    mapConversation,
  );
  const loadError = error;
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
  const todayKey = new Date().toDateString();
  const callConversations = conversationRecords
    .filter(item => item.channel === 'call')
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const callsToday = callConversations.filter(item => new Date(item.createdAt).toDateString() === todayKey);
  // The legacy aiHandled flag has no actor/model provenance. Count only an
  // actual stored outbound request and do not attribute it to AI.
  const followUpEvidenceCount = callConversations.filter(item => Boolean(item.lastAgentMessage)).length;
  const unresolved = conversationRecords.filter(item => item.status !== 'replied').length;
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
    if (status === 'replied' && !selectedConv.replyReadiness.ready) {
      setSendError(`Submission is disabled: ${humanizeToken(selectedConv.replyReadiness.readinessReason).toLowerCase()}.`);
      return;
    }
    if (status === 'replied' && !clientAttemptKey) {
      setSendError('A durable submission attempt could not be initialized. Close and reopen the confirmation.');
      return;
    }
    setIsSending(true);
    setSendError(null);
    setSendNotice(null);
    try {
      const result = await apiRequest<ConversationReplyResult>(`/v1/conversations/${selectedConv.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: message.trim(), status, ...(status === 'replied' ? { clientAttemptKey } : {}) }),
      });
      const deliveryStatus = result.deliveryStatus.toLowerCase();
      setSendNotice(status === 'escalated'
        ? 'Internal escalation recorded. No patient message was submitted.'
        : deliveryStatus === 'submission_result_unknown'
          ? 'Submission result unknown. Retry is blocked until provider evidence is reconciled.'
        : deliveryStatus === 'delivered'
          ? 'The provider reports the reply was delivered.'
          : ['sent', 'accepted'].includes(deliveryStatus) || result.accepted
            ? 'The provider accepted the reply request. Delivery is not confirmed.'
            : result.message);
      await reload();
      setReplyText('');
      if (deliveryStatus !== 'submission_result_unknown') setClientAttemptKey('');
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
        subtitle="Conversation records, missed-call follow-up, and staff-reviewed front-desk reply workflows."
        badge={loadError ? 'Data unavailable' : `Unread: ${unresolved} · ${source === 'live' ? 'Stored clinic records' : 'Loading'}`}
        badgeColor={loadError ? 'red' : 'red'}
        actions={
          <button type="button" onClick={() => navigate('/settings')} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Bot className="w-4 h-4" /> CareDesk AI Settings
          </button>
        }
      />

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Conversation records could not be loaded from the clinic API: {loadError}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Call records today" value={String(callsToday.length)} subtitle="All calls on the browser-local date" icon={<Phone className="w-4 h-4" />} accent="red" />
        <StatCard title="Follow-up evidence" value={`${followUpEvidenceCount}/${callConversations.length}`} subtitle="Stored staff-submitted outbound request" icon={<Bot className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Avg recorded request lag" value={`${avgReplyMinutes ? `${avgReplyMinutes} min` : 'n/a'}`} subtitle="Conversation record to outbound request" icon={<Clock className="w-4 h-4" />} accent="blue" />
        <StatCard title="Open Conversations" value={String(unresolved)} subtitle="Needs review or action" icon={<Calendar className="w-4 h-4" />} accent="violet" />
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
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {source === 'live' ? 'Stored inbox records' : 'Loading'}
                </span>
              </div>
              <ModuleTabs tabs={channelTabs} activeTab={activeChannel} onChange={setActiveChannel} variant="pills" />
            </div>
            <div className="divide-y divide-[var(--b0)]">
              {filtered.length === 0 ? (
                <p className="px-4 py-6 text-sm text-t3">No conversation records were returned for this clinic.</p>
              ) : filtered.map((conv) => {
                const status = statusConfig[conv.status] ?? statusConfig.pending;
                const isSelected = selectedConv?.id === conv.id;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(conv.id);
                      setReplyText('');
                      setSendNotice(null);
                      setSendError(null);
                      setClientAttemptKey('');
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
                        {conv.lastAgentMessage ? ` · Outbound request: ${conv.lastAgentMessage}` : ''}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={status.badgeClass}>{status.label}</span>
                        <span className="ml-auto text-right text-[10px] font-bold text-emerald-v">
                          Recorded est. {conv.value}<span className="block font-medium text-t3">source not verified</span>
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <BentoCard title="Conversation Review" subtitle="Recorded context and server authorization evidence" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
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
                    <p className="text-[10px] font-bold text-emerald-v uppercase tracking-wide mb-0.5">Recorded value</p>
                    <p className="text-xs font-bold text-emerald-v">{selectedConv.value}</p>
                    <p className="text-[9px] text-t3">{selectedConv.valueEvidence}</p>
                  </div>
                </div>
                <div className="space-y-2 rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-3" aria-label="Reply readiness evidence">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Reply authorization</p>
                    <span className={`badge ${selectedConv.replyReadiness.ready ? 'badge-emerald' : 'badge-red'}`}>
                      {selectedConv.replyReadiness.ready ? 'Ready for server recheck' : 'Not ready'}
                    </span>
                  </div>
                  <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-x-3 gap-y-1 text-[11px]">
                    <dt className="text-t3">Channel + masked destination</dt>
                    <dd className="text-right font-semibold text-t1">
                      {selectedConv.replyReadiness.channel?.toUpperCase() ?? 'Unavailable'} · {selectedConv.replyReadiness.destinationMasked ?? 'No destination'}
                    </dd>
                    <dt className="text-t3">Patient-link identity</dt>
                    <dd className="text-right font-semibold text-t1">{humanizeToken(selectedConv.replyReadiness.identityStatus)}</dd>
                    <dt className="text-t3">Destination evidence</dt>
                    <dd className="text-right font-semibold text-t1">
                      {selectedConv.replyReadiness.destinationVerificationStatus === 'format_verified' ? 'Format verified' : 'Not verified'} · {humanizeToken(selectedConv.replyReadiness.destinationSource).toLowerCase()}
                    </dd>
                    <dt className="text-t3">Explicit consent</dt>
                    <dd className="text-right font-semibold text-t1">
                      {humanizeToken(selectedConv.replyReadiness.explicitConsentStatus)}
                      <span className="block font-normal text-t3">Source: {selectedConv.replyReadiness.consentSource ?? 'not recorded'}</span>
                    </dd>
                    <dt className="text-t3">Operational basis</dt>
                    <dd className="text-right font-semibold text-t1">{humanizeToken(selectedConv.replyReadiness.authorizationBasis)}</dd>
                    <dt className="text-t3">Canonical sender</dt>
                    <dd className="text-right font-semibold text-t1">{selectedConv.replyReadiness.senderIdentity}</dd>
                    <dt className="text-t3">Channel terms</dt>
                    <dd className="text-right font-semibold text-t1">
                      Operational reply only
                      <span className="block font-normal text-t3">{selectedConv.replyReadiness.channelTermsSource}</span>
                    </dd>
                    <dt className="text-t3">Current suppression state</dt>
                    <dd className="text-right font-semibold text-t1">{humanizeToken(selectedConv.replyReadiness.suppressionStatus)}</dd>
                    <dt className="text-t3">Submission state</dt>
                    <dd className="text-right font-semibold text-t1">{humanizeToken(selectedConv.replyReadiness.submissionState)}</dd>
                    <dt className="text-t3">Draft attribution</dt>
                    <dd className="text-right font-semibold text-t1">Rule-based · requires staff review</dd>
                  </dl>
                  {!selectedConv.replyReadiness.ready && (
                    <p className="rounded-lg bg-[var(--red-soft)] px-2 py-1.5 text-[10px] font-semibold text-red-v">
                      Submission unavailable: {humanizeToken(selectedConv.replyReadiness.readinessReason).toLowerCase()}.
                    </p>
                  )}
                </div>
                {selectedConv.lastAgentMessage && (
                  <div className="p-3 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
                    <p className="text-[10px] font-bold text-t3 uppercase tracking-widest mb-1">Last staff-submitted outbound message request</p>
                    <p className="text-sm text-t1 leading-relaxed">{selectedConv.lastAgentMessage}</p>
                    {selectedConv.lastAgentMessageAt && <p className="text-[10px] text-t3 mt-1">{new Date(selectedConv.lastAgentMessageAt).toLocaleString()}</p>}
                  </div>
                )}
                {selectedConv.suggestedSlot && (
                  <div className="p-3 rounded-xl border border-[var(--b2)] bg-[var(--violet-soft)]">
                    <div className="flex items-center gap-2 mb-1">
                      <Calendar className="w-3.5 h-3.5 text-violet-v" />
                      <p className="text-[10px] font-bold text-violet-v uppercase tracking-wide">Suggested time — not booked</p>
                    </div>
                    <p className="text-sm font-bold text-t1">{selectedConv.suggestedSlot}</p>
                    <button type="button" onClick={() => navigate('/scheduling')} className="mt-2 w-full py-1.5 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-colors">
                      Review in scheduling
                    </button>
                  </div>
                )}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-bold text-t3 uppercase tracking-widest">Rule-based draft · staff review required</p>
                  <textarea
                    key={selectedConv?.id ?? 'none'}
                    defaultValue={replyPreview}
                    onChange={event => {
                      setReplyText(event.target.value);
                      setClientAttemptKey('');
                    }}
                    rows={4}
                    className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t2 leading-relaxed outline-none focus:border-indigo"
                    aria-label="Reviewed reply text"
                    placeholder="Review and edit the rule-based draft"
                  />
                  {sendError && <p className="text-[11px] font-semibold text-red-v">{sendError}</p>}
                  {sendNotice && <p role="status" aria-live="polite" className="rounded-lg border border-[var(--b1)] bg-[var(--blue-soft)] px-2.5 py-2 text-[11px] font-semibold text-blue-v">{sendNotice}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isSending || !selectedConv.replyReadiness.ready}
                      onClick={() => {
                        setClientAttemptKey(crypto.randomUUID());
                        setConfirmReplyOpen(true);
                      }}
                      className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-[var(--b2)] text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition-colors disabled:opacity-60"
                    >
                      <Zap className="w-3 h-3" /> {isSending ? 'Submitting…' : 'Submit reviewed reply'}
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

          <BentoCard title="Missed-Call Follow-up" subtitle="Stored call and reply records" headerRight={
            <span className="text-xs font-bold text-emerald-v bg-[var(--emerald-soft)] px-2 py-1 rounded-full border border-[var(--b1)]">{followUpEvidenceCount}/{callConversations.length} with evidence</span>
          }>
            <div className="space-y-3">
              {(callConversations.length ? callConversations : conversationRecords.slice(0, 5)).length === 0 ? (
                <p className="text-xs text-t3">No call follow-up records are available yet.</p>
              ) : (callConversations.length ? callConversations : conversationRecords.slice(0, 5)).map((call, index) => {
                const hasFollowUpEvidence = Boolean(call.lastAgentMessage);
                return (
                  <div key={call.id} className="flex items-start gap-3">
                    <div className="flex flex-col items-center gap-1">
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${hasFollowUpEvidence ? 'bg-[var(--emerald-soft)]' : 'bg-[var(--red-soft)]'}`}>
                        {hasFollowUpEvidence ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-v" /> : <AlertCircle className="w-3.5 h-3.5 text-red-v" />}
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
                        <span className={`text-[10px] font-semibold ${hasFollowUpEvidence ? 'text-emerald-v' : 'text-red-v'}`}>{hasFollowUpEvidence ? 'Staff follow-up request recorded' : 'Needs review'}</span>
                        <span className="text-t3">·</span>
                        <span className="text-[10px] text-t3">{call.lastAgentMessage ?? call.message}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => navigate('/control-plane')} className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-[var(--b2)] text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition-colors">
              <ArrowRight className="w-3 h-3" /> View full call log
            </button>
          </BentoCard>

          <BentoCard title="After-Hours Activity" subtitle="Unavailable until clinic hours and timezone are configured">
            <div className="rounded-xl border border-dashed border-[var(--b2)] bg-[var(--s3)] p-4 text-center">
              <Clock className="mx-auto mb-2 h-5 w-5 text-t3" aria-hidden="true" />
              <p className="text-xs font-semibold text-t2">No after-hours metric is calculated.</p>
              <p className="mt-1 text-[11px] text-t3">Browser-local time is not used as a substitute for verified clinic hours and timezone.</p>
            </div>
          </BentoCard>
        </div>
      </div>
      {confirmReplyOpen && selectedConv && (
        <ConfirmationModal
          title="Submit reviewed reply?"
          message={`Submit as ${selectedConv.replyReadiness.senderIdentity} through ${selectedConv.replyReadiness.channel?.toUpperCase() ?? 'the configured channel'} to ${selectedConv.replyReadiness.destinationMasked ?? 'the recorded destination'} under the operational-reply-only channel terms? The server rechecks suppression at submission. A durable claim is recorded before provider contact; an uncertain result blocks retry. Provider acceptance does not confirm delivery; delivery evidence must arrive separately.`}
          confirmLabel="Submit reply request"
          onConfirm={async () => sendReply('replied')}
          onClose={() => setConfirmReplyOpen(false)}
        />
      )}
    </div>
  );
}
