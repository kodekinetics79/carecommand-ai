import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Plus, Loader2, Users, ShieldAlert, Send, CheckCircle2, Pause, Sparkles, AlertCircle, Pencil, Trash2, Ban, X, Save } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import {
  crmApi, AUDIENCE_TYPES, CAMPAIGN_TYPES, CAMPAIGN_STATUS_META, DELIVERY_STATUS_META,
  type Campaign, type AudiencePreview, type CampaignDraft, type LaunchResult, type CampaignDelivery,
  type AudienceType, type CampaignType, type CommChannel,
} from '../lib/crm';

const CHANNELS: CommChannel[] = ['sms', 'email', 'voice', 'whatsapp'];

export default function CampaignEngine() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      const rows = await crmApi.listCampaigns();
      setCampaigns(rows);
      setSelectedId(prev => (prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const rows = await crmApi.listCampaigns();
        if (!active) return;
        setCampaigns(rows);
        setSelectedId(prev => (prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? ''));
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load campaigns');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const selected = campaigns.find(c => c.id === selectedId) ?? null;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader title="Reactivation Engine" subtitle="Rule-based recall, recovery, and revenue-recovery campaigns — every send requires approval and respects consent." badge="New" badgeColor="violet" />
      {error && <p className="text-sm text-red-v">{error}</p>}
      {loading ? (
        <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="inline w-5 h-5 animate-spin" /></div>
      ) : (
        <div className="grid lg:grid-cols-[300px_1fr] gap-5">
          <div className="cc-card p-3 space-y-1.5 h-max">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-t3">Campaigns</span>
              <button type="button" aria-label="New campaign" onClick={() => setCreating(true)} className="text-indigo hover:opacity-80"><Plus className="w-4 h-4" /></button>
            </div>
            {campaigns.length === 0 && <p className="px-1 py-3 text-xs text-t3">No campaigns yet.</p>}
            {campaigns.map(c => {
              const meta = CAMPAIGN_STATUS_META[c.status] ?? { label: c.status, badge: 'badge-blue' };
              return (
                <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${selectedId === c.id ? 'bg-[var(--s2)] text-t1' : 'text-t2 hover:bg-[var(--s2)]'}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold truncate">{c.name}</span>
                    <span className={`badge ${meta.badge} shrink-0`}>{meta.label}</span>
                  </span>
                  <span className="text-[10px] text-t3">{c.campaignType} · {c.channel ?? '—'}{c.requiresApprovalPending ? ' · approval needed' : ''}</span>
                </button>
              );
            })}
          </div>

          <div className="space-y-5">
            {creating && <CampaignCreator onCancel={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await reload(); setSelectedId(id); }} />}
            {!creating && selected && <CampaignDetail key={selected.id} campaign={selected} onChanged={reload} onDeleted={async () => { setSelectedId(''); await reload(); }} />}
            {!creating && !selected && <div className="cc-card p-10 text-center text-sm text-t3">Select or create a campaign.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function CampaignCreator({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [campaignType, setType] = useState<CampaignType>('inactive_patient_reactivation');
  const [audienceType, setAudience] = useState<AudienceType>('inactive_patients');
  const [channel, setChannel] = useState<CommChannel>('sms');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setBusy(true); setErr(null);
    try {
      const row = await crmApi.createCampaign({ name, campaignType, audienceType, channel });
      onCreated(row.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create campaign');
    } finally {
      setBusy(false);
    }
  }

  const inputCls = 'w-full rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-sm text-t1 outline-none focus:border-indigo';
  return (
    <div className="cc-card p-5 space-y-4">
      <h3 className="text-sm font-bold text-t1 flex items-center gap-2"><Megaphone className="w-4 h-4 text-indigo" /> New campaign</h3>
      <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Name</span>
        <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Q3 reactivation" /></label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Type</span>
          <select aria-label="Campaign type" className={inputCls} value={campaignType} onChange={e => setType(e.target.value as CampaignType)}>{CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Audience</span>
          <select aria-label="Audience type" className={inputCls} value={audienceType} onChange={e => setAudience(e.target.value as AudienceType)}>{AUDIENCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Channel</span>
          <select aria-label="Channel" className={inputCls} value={channel} onChange={e => setChannel(e.target.value as CommChannel)}>{CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      {err && <p className="text-xs text-red-v">{err}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !name} onClick={create} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create</button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)]">Cancel</button>
      </div>
    </div>
  );
}

function CampaignDetail({ campaign, onChanged, onDeleted }: { campaign: Campaign; onChanged: () => void; onDeleted: () => void }) {
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [launch, setLaunch] = useState<LaunchResult | null>(null);
  const [deliveries, setDeliveries] = useState<CampaignDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const meta = CAMPAIGN_STATUS_META[campaign.status] ?? { label: campaign.status, badge: 'badge-blue' };
  const audienceType = (campaign.audienceType ?? 'inactive_patients') as AudienceType;
  const channel = (campaign.channel ?? 'sms') as CommChannel;

  const loadAux = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        crmApi.previewAudience(audienceType, channel).catch(() => null),
        crmApi.listDeliveries(campaign.id).catch(() => [] as CampaignDelivery[]),
      ]);
      setPreview(p); setDeliveries(d);
    } catch { /* ignore */ }
  }, [audienceType, channel, campaign.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [p, d] = await Promise.all([
        crmApi.previewAudience(audienceType, channel).catch(() => null),
        crmApi.listDeliveries(campaign.id).catch(() => [] as CampaignDelivery[]),
      ]);
      if (!active) return;
      setPreview(p); setDeliveries(d); setDraft(null); setLaunch(null); setNotice(null); setError(null);
    })();
    return () => { active = false; };
  }, [audienceType, channel, campaign.id]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(false); }
  }

  const actions = campaign.allowedActions;

  return (
    <div className="space-y-5">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1">{campaign.name}</h3>
          <span className={`badge ${meta.badge}`}>{meta.label}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="badge badge-blue">{campaign.campaignType}</span>
          <span className="badge badge-violet">{campaign.audienceType}</span>
          <span className="badge badge-blue">{campaign.channel}</span>
          {campaign.requiresApprovalPending && <span className="badge badge-amber">Approval required</span>}
        </div>
        {campaign.messageTemplate && <p className="text-xs text-t3 whitespace-pre-wrap rounded-lg border border-[var(--b1)] p-2.5">{campaign.messageSubject ? `${campaign.messageSubject}\n` : ''}{campaign.messageTemplate}</p>}
        {notice && <p className="text-[11px] text-emerald-v">{notice}</p>}
        {error && <p className="text-[11px] text-red-v">{error}</p>}
        <div className="flex flex-wrap gap-2">
          {actions.includes('generate_draft') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { const d = await crmApi.generateDraft(campaign.id); setDraft(d); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><Sparkles className="w-3.5 h-3.5" /> Generate draft (rule-based)</button>
          )}
          {actions.includes('approve') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { await crmApi.approve(campaign.id); setNotice('Approved.'); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5" /> Approve</button>
          )}
          {actions.includes('launch') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { const r = await crmApi.launch(campaign.id); setLaunch(r); setNotice(r.setupRequired ? 'Provider not configured — nothing sent.' : `Launched: ${r.summary.sent} sent, ${r.summary.suppressed} suppressed.`); await loadAux(); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"><Send className="w-3.5 h-3.5" /> Launch</button>
          )}
          {actions.includes('pause') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { await crmApi.pause(campaign.id); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><Pause className="w-3.5 h-3.5" /> Pause</button>
          )}
          {actions.includes('edit') && (
            <button type="button" disabled={busy} onClick={() => { setEditing(v => !v); setError(null); setNotice(null); }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50"><Pencil className="w-3.5 h-3.5" /> {editing ? 'Close editor' : 'Edit'}</button>
          )}
          {actions.includes('cancel') && (
            <button type="button" disabled={busy} onClick={() => run(async () => { await crmApi.cancel(campaign.id); setNotice('Campaign cancelled.'); onChanged(); })} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-v/30 text-amber-v px-2.5 py-1.5 text-[11px] font-semibold hover:bg-amber-v/5 disabled:opacity-50"><Ban className="w-3.5 h-3.5" /> Cancel campaign</button>
          )}
          <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-v/30 text-red-v px-2.5 py-1.5 text-[11px] font-semibold hover:bg-red-v/5 disabled:opacity-50"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
        </div>
        {confirmDelete && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-v/30 bg-red-v/5 px-3 py-2 text-[11px]">
            <span className="text-red-v font-semibold">Delete “{campaign.name}” and its delivery log? This cannot be undone.</span>
            <span className="flex gap-1.5 shrink-0">
              <button type="button" disabled={busy} onClick={() => run(async () => { await crmApi.deleteCampaign(campaign.id); onDeleted(); })} className="rounded-md bg-red-v px-2.5 py-1 font-semibold text-white hover:opacity-90 disabled:opacity-50">Delete</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md border border-[var(--b1)] px-2.5 py-1 font-semibold text-t2 hover:bg-[var(--s2)]">Keep</button>
            </span>
          </div>
        )}
        {editing && (
          <CampaignEditForm campaign={campaign} onSaved={() => { setEditing(false); setNotice('Changes saved.'); onChanged(); }} onError={setError} />
        )}
        {draft && (
          <div className="rounded-lg border border-amber-v/30 bg-amber-v/5 p-2.5 text-[11px] text-t2 space-y-1">
            <p className="font-semibold text-t1">Draft ({draft.draftSource}) — requires approval</p>
            {draft.warnings.map(w => <p key={w} className="text-amber-v">• {w}</p>)}
          </div>
        )}
        {launch?.setupRequired && (
          <div className="flex items-center gap-2 rounded-lg border border-red-v/40 bg-red-v/5 px-2.5 py-1.5 text-[11px] text-red-v">
            <AlertCircle className="w-3.5 h-3.5" /> {launch.provider.channel} provider not configured ({launch.provider.missing.join(', ')}). No messages sent.
          </div>
        )}
      </div>

      {preview && (
        <div className="cc-card p-5">
          <h4 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><Users className="w-4 h-4 text-indigo" /> Audience preview</h4>
          <div className="grid grid-cols-4 gap-3 text-center">
            <Stat label="Total" value={preview.total} />
            <Stat label="Eligible" value={preview.eligible} accent="emerald" />
            <Stat label="Suppressed" value={preview.suppressed} accent="violet" />
            <Stat label="No contact" value={preview.missingContact} accent="amber" />
          </div>
          {preview.sample.length > 0 && (
            <div className="mt-3 space-y-1">
              {preview.sample.map((s, i) => <p key={i} className="text-[11px] text-t3">{s.name} · {s.reason} · {s.destinationMasked}</p>)}
            </div>
          )}
        </div>
      )}

      <div className="cc-card p-5">
        <h4 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-indigo" /> Delivery log ({deliveries.length})</h4>
        {deliveries.length === 0 ? <p className="text-xs text-t3">No deliveries yet. Launch to generate truthful delivery rows.</p> : (
          <div className="space-y-1.5">
            {deliveries.slice(0, 50).map(d => {
              const dm = DELIVERY_STATUS_META[d.status] ?? { label: d.status, badge: 'badge-blue' };
              return (
                <div key={d.deliveryId} className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">
                  <span className="text-t2">{d.destinationMasked ?? '—'} · {d.channel}</span>
                  <span className={`badge ${dm.badge}`}>{dm.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CampaignEditForm({ campaign, onSaved, onError }: { campaign: Campaign; onSaved: () => void; onError: (msg: string | null) => void }) {
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.messageSubject ?? '');
  const [template, setTemplate] = useState(campaign.messageTemplate ?? '');
  const [channel, setChannel] = useState<CommChannel>((campaign.channel ?? 'sms') as CommChannel);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true); onError(null);
    try {
      await crmApi.updateCampaign(campaign.id, {
        name: name.trim(),
        messageSubject: subject.trim() || undefined,
        messageTemplate: template.trim() || undefined,
        channel,
      });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-sm text-t1 outline-none focus:border-indigo';
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-3">
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Edit campaign</p>
      <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Name</span>
        <input className={inputCls} value={name} onChange={e => setName(e.target.value)} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Message subject (email)</span>
          <input className={inputCls} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Optional" /></label>
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Channel</span>
          <select aria-label="Channel" className={inputCls} value={channel} onChange={e => setChannel(e.target.value as CommChannel)}>{CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Message template</span>
        <textarea className={`${inputCls} min-h-[80px] resize-y`} value={template} onChange={e => setTemplate(e.target.value)} placeholder="Hi {{firstName}}, …" /></label>
      <div className="flex gap-2">
        <button type="button" disabled={saving || name.trim().length < 2} onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save changes</button>
        <button type="button" onClick={() => onSaved()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]"><X className="w-3.5 h-3.5" /> Close</button>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = accent === 'emerald' ? 'text-emerald-v' : accent === 'violet' ? 'text-violet-v' : accent === 'amber' ? 'text-amber-v' : 'text-t1';
  return (
    <div className="rounded-xl border border-[var(--b1)] py-2.5">
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-[10px] text-t3">{label}</p>
    </div>
  );
}
