import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Copy, Download, FileText, Link2, Loader2, RefreshCw, Save, Upload, UserRoundPlus } from 'lucide-react';
import {
  platformAdmin,
  type PilotChecklistView,
  type PilotEntityType,
  type PilotImportPreset,
  type PilotImportPreview,
  type PilotStatusShareCreated,
  type PilotStatusShare,
  type TenantSummary,
} from '../lib/platformAdmin';

const ENTITY_LABELS: Record<PilotEntityType, string> = {
  patients: 'Patients',
  appointments: 'Appointments',
  insurance: 'Insurance',
};

const ENTITY_HELP: Record<PilotEntityType, string> = {
  patients: 'Use this for patient demographics and identifiers.',
  appointments: 'Use this after patient rows are in place.',
  insurance: 'Use this for active coverage and payer details.',
};

const ENTITY_ORDER: PilotEntityType[] = ['patients', 'appointments', 'insurance'];

function autoSlug(v: string) {
  return v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function csvSnippet(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(0, 6).join('\n');
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
}

export default function PlatformPilot() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [checklist, setChecklist] = useState<PilotChecklistView | null>(null);
  const [busy, setBusy] = useState<'tenants' | 'checklist' | 'create' | 'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pilot import reads and writes a clinic's patient and appointment rows, so
  // the server refuses it without a live, reason-carrying support session. A
  // bare 403 would read as "the console is broken", so offer the remedy inline.
  const [supportReason, setSupportReason] = useState('');
  const [supportBusy, setSupportBusy] = useState(false);
  const needsSupportSession = Boolean(error && /support session/i.test(error));

  const [companyOpen, setCompanyOpen] = useState(true);
  const [companyName, setCompanyName] = useState('');
  const [companySlug, setCompanySlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [planKey, setPlanKey] = useState('');
  const [planOptions, setPlanOptions] = useState<Array<{ key: string; name: string }>>([]);
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [branchName, setBranchName] = useState('Main Branch');
  // Plan used to be a free-text box defaulting to a hardcoded 'starter': a typo
  // produced a 400 at the end of a long form, and Platform Settings' default
  // plan could never apply. Both are now driven by the server.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      platformAdmin.plans().catch(() => [] as Array<{ key: string; name: string }>),
      platformAdmin.getSettings().catch(() => null),
    ]).then(([catalog, cfg]) => {
      if (!alive) return;
      setPlanOptions(catalog);
      setPlanKey(prev => prev || cfg?.defaultPlanKey || catalog[0]?.key || 'starter');
      if (cfg?.defaultBranchName) setBranchName(prev => (prev === 'Main Branch' ? cfg.defaultBranchName : prev));
    });
    return () => { alive = false; };
  }, []);
  const [timezone, setTimezone] = useState(localTimezone);

  const [entityType, setEntityType] = useState<PilotEntityType>('patients');
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<PilotImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<string | null>(null);
  const [presets, setPresets] = useState<PilotImportPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetDefault, setPresetDefault] = useState(true);
  const [shareLabel, setShareLabel] = useState('Pilot status');
  const [shareDays, setShareDays] = useState(14);
  const [shareResult, setShareResult] = useState<PilotStatusShareCreated | null>(null);
  const [shares, setShares] = useState<PilotStatusShare[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setBusy('tenants');
      setError(null);
      try {
        const rows = await platformAdmin.tenants();
        if (!active) return;
        setTenants(rows);
        const first = rows.find(r => r.tenant)?.tenant?.id ?? '';
        setSelectedTenantId(prev => prev || first);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load tenants');
      } finally {
        if (active) setBusy(null);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedTenantId) return;
    let active = true;
    void (async () => {
      setBusy('checklist');
      setError(null);
      try {
        const data = await platformAdmin.getPilotChecklist(selectedTenantId);
        if (!active) return;
        setChecklist(data);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load pilot checklist');
      } finally {
        if (active) setBusy(null);
      }
    })();
    return () => { active = false; };
  }, [selectedTenantId]);

  useEffect(() => {
    if (!selectedTenantId) return;
    let active = true;
    void (async () => {
      try {
        const rows = await platformAdmin.getPilotImportPresets(selectedTenantId, entityType);
        if (!active) return;
        setPresets(rows);
        const preferred = rows.find(row => row.isDefault) ?? rows[0] ?? null;
        setSelectedPresetId(preferred?.id ?? '');
        setPresetName(preferred?.name ?? '');
        setPresetDefault(preferred?.isDefault ?? true);
      } catch {
        if (active) {
          setPresets([]);
          setSelectedPresetId('');
          setPresetName('');
          setPresetDefault(true);
        }
      }
    })();
    return () => { active = false; };
  }, [selectedTenantId, entityType]);

  useEffect(() => {
    if (!selectedTenantId) return;
    let active = true;
    void platformAdmin.listPilotStatusShares(selectedTenantId)
      .then(rows => { if (active) setShares(rows); })
      .catch(() => { if (active) setShares([]); });
    return () => { active = false; };
  }, [selectedTenantId]);

  async function reloadTenants(nextTenantId?: string) {
    const rows = await platformAdmin.tenants();
    setTenants(rows);
    const next = nextTenantId ?? selectedTenantId;
    const fallback = rows.find(r => r.tenant?.id === next)?.tenant?.id ?? rows.find(r => r.tenant)?.tenant?.id ?? '';
    setChecklist(null);
    setPreview(null);
    setMapping({});
    setImportResult(null);
    setShareResult(null);
    setShares([]);
    setSelectedPresetId('');
    setPresetName('');
    setPresetDefault(true);
    setSelectedTenantId(fallback);
  }

  async function createTenant() {
    setBusy('create');
    setError(null);
    try {
      const created = await platformAdmin.createTenant({
        name: companyName.trim(),
        slug: companySlug.trim(),
        planKey,
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        ownerPassword,
        defaultBranchName: branchName.trim() || 'Main Branch',
        timezone,
      });
      await reloadTenants(created.tenant?.id);
      setCompanyName('');
      setCompanySlug('');
      setSlugEdited(false);
      setOwnerName('');
      setOwnerEmail('');
      setOwnerPassword('');
      setBranchName('Main Branch');
      setTimezone(localTimezone());
      setCompanyOpen(false);
      setImportResult(`Created ${created.tenant?.name ?? 'tenant'} and owner ${ownerEmail.trim()}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create company');
    } finally {
      setBusy(null);
    }
  }

  async function previewImport() {
    if (!selectedTenantId) return;
    setBusy('preview');
    setError(null);
    setImportResult(null);
    try {
      const result = await platformAdmin.previewPilotImport(selectedTenantId, entityType, { csvText, mapping });
      setPreview(result);
      setMapping(result.mapping);
      if (result.preset) setSelectedPresetId(result.preset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(null);
    }
  }

  async function commitImport() {
    if (!selectedTenantId) return;
    setBusy('commit');
    setError(null);
    try {
      const result = await platformAdmin.commitPilotImport(selectedTenantId, entityType, { csvText, mapping });
      setImportResult(`Imported ${result.summary.validRows} of ${result.summary.total} row(s): ${result.summary.created} created, ${result.summary.updated} updated, ${result.summary.skipped} skipped.`);
      await reloadTenants(selectedTenantId);
      const refreshed = await platformAdmin.getPilotChecklist(selectedTenantId);
      setChecklist(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(null);
    }
  }

  async function downloadTemplate() {
    if (!selectedTenantId) return;
    setBusy('preview');
    setError(null);
    try {
      await platformAdmin.downloadPilotTemplate(selectedTenantId, entityType);
      setImportResult(`Downloaded ${ENTITY_LABELS[entityType]} template.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Template download failed');
    } finally {
      setBusy(null);
    }
  }

  function applyPreset(presetId: string) {
    setSelectedPresetId(presetId);
    if (!presetId) {
      setImportResult('Cleared preset selection.');
      return;
    }
    const preset = presets.find(row => row.id === presetId);
    if (!preset) return;
    setPresetName(preset.name);
    setPresetDefault(preset.isDefault);
    setMapping(preset.mapping);
    setPreview(null);
    setImportResult(`Applied preset ${preset.name}.`);
  }

  async function savePreset() {
    if (!selectedTenantId || !presetName.trim()) return;
    setBusy('commit');
    setError(null);
    try {
      const saved = await platformAdmin.savePilotImportPreset(selectedTenantId, {
        entityType,
        name: presetName.trim(),
        mapping,
        isDefault: presetDefault,
      });
      setPresets(prev => {
        const next = prev.filter(row => row.id !== saved.id);
        next.unshift(saved);
        return next;
      });
      setSelectedPresetId(saved.id);
      setImportResult(`Saved preset ${saved.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save preset');
    } finally {
      setBusy(null);
    }
  }

  async function createShareLink() {
    if (!selectedTenantId) return;
    setBusy('commit');
    setError(null);
    try {
      const created = await platformAdmin.createPilotStatusShare(selectedTenantId, { label: shareLabel.trim() || undefined, expiresInDays: shareDays });
      setShareResult(created);
      setShares(await platformAdmin.listPilotStatusShares(selectedTenantId));
      setImportResult(`Created share link for ${created.clinicName}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create share link');
    } finally {
      setBusy(null);
    }
  }

  async function copyShareUrl() {
    if (!shareResult?.url) return;
    try {
      await navigator.clipboard.writeText(shareResult.url);
      setImportResult('Pilot share link copied.');
    } catch {
      setError('The browser could not copy the link. Select the displayed URL and copy it manually.');
    }
  }

  async function revokeShareLink(shareId: string) {
    if (!selectedTenantId) return;
    setBusy('commit'); setError(null);
    try {
      await platformAdmin.revokePilotStatusShare(selectedTenantId, shareId);
      setShares(await platformAdmin.listPilotStatusShares(selectedTenantId));
      if (shareResult?.id === shareId) setShareResult(null);
      setImportResult('Pilot status link revoked. It can no longer be opened.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke pilot status link');
    } finally {
      setBusy(null);
    }
  }

  const canImport = !!selectedTenantId && !!csvText.trim() && !!preview && preview.summary.invalid === 0;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-[var(--b1)] bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(247,249,255,0.92))] p-5 shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
        <div className="h-1 bg-[linear-gradient(90deg,var(--indigo),rgba(37,99,235,0.64),rgba(8,145,178,0.72))]" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-t3">Customer handoff workspace</p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-t1">Platform admin creates the clinic, client setup tests it, patients use the portal</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-t2">This launchpad follows the pilot sequence you described: provision the clinic tenant, load or update real clinic data, run module-level checks with the client team, and then hand over patient portal access according to the clinic’s own settings.</p>
          </div>
          <button type="button" onClick={() => void reloadTenants(selectedTenantId)} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s3)]">
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 shadow-sm">
            <p className="text-[11px] font-bold uppercase tracking-wide text-t3">1. Platform admin</p>
            <p className="mt-1 text-sm text-t2">Create the clinic tenant, owner login, branch, and pilot status link.</p>
          </div>
          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 shadow-sm">
            <p className="text-[11px] font-bold uppercase tracking-wide text-t3">2. Client setup</p>
            <p className="mt-1 text-sm text-t2">Load or update existing clinic data, preview errors, save mappings, and run module tests with the client team.</p>
          </div>
          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 shadow-sm">
            <p className="text-[11px] font-bold uppercase tracking-wide text-t3">3. Patient portal</p>
            <p className="mt-1 text-sm text-t2">Give the clinic’s patients only the access the clinic chooses, then let them test their own portal flows.</p>
          </div>
        </div>
        {error && (
          <div className="mt-4 rounded-xl border border-[rgba(220,38,38,0.18)] bg-red-soft px-3 py-2 text-sm text-red-v">
            <p>{error}</p>
            {needsSupportSession && selectedTenantId && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={supportReason}
                  onChange={e => setSupportReason(e.target.value)}
                  placeholder="Why you need access (recorded)"
                  aria-label="Support session reason"
                  className="flex-1 min-w-[220px] rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-1.5 text-xs text-t1 outline-none"
                />
                <button
                  type="button"
                  disabled={supportBusy || supportReason.trim().length < 3}
                  onClick={async () => {
                    setSupportBusy(true);
                    try {
                      await platformAdmin.startSupport(selectedTenantId, supportReason.trim(), 60);
                      setSupportReason('');
                      setError(null);
                      const data = await platformAdmin.getPilotChecklist(selectedTenantId);
                      setChecklist(data);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Could not open a support session');
                    } finally {
                      setSupportBusy(false);
                    }
                  }}
                  className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {supportBusy ? 'Opening…' : 'Open 60-minute support session'}
                </button>
              </div>
            )}
          </div>
        )}
        {importResult && <div className="mt-4 rounded-xl border border-[rgba(5,150,105,0.18)] bg-emerald-soft px-3 py-2 text-sm text-emerald-v">{importResult}</div>}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="rounded-[2rem] border border-[var(--b1)] bg-[var(--s1)] p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Clinic tenant</p>
            <h3 className="text-lg font-bold text-t1">Select the client clinic to load or update</h3>
              </div>
              <select aria-label="Clinic tenant" value={selectedTenantId} onChange={e => {
                setSelectedTenantId(e.target.value);
                setChecklist(null);
                setPreview(null);
                setMapping({});
                setImportResult(null);
                setShareResult(null);
                setShares([]);
                setSelectedPresetId('');
                setPresetName('');
                setPresetDefault(true);
              }} className="min-w-56 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1">
                <option value="">Choose a tenant…</option>
                {tenants.filter(t => t.tenant).map(t => <option key={t.tenant!.id} value={t.tenant!.id}>{t.tenant!.name} ({t.tenant!.slug})</option>)}
              </select>
            </div>
            {!selectedTenantId && !busy && (
              <div className="mt-4 rounded-2xl border border-dashed border-[var(--b1)] bg-[var(--s2)] p-4">
                <p className="text-sm font-semibold text-t1">Pick or create a clinic to continue</p>
                <p className="mt-1 text-xs text-t3">The pilot workspace stays empty until a tenant is selected. Create the client company above or choose an existing clinic from the dropdown.</p>
              </div>
            )}
            {checklist && selectedTenantId && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-[var(--b1)] bg-[linear-gradient(135deg,var(--s2),var(--s1))] p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-t3">Checklist completion</p>
                  <p className="mt-1 text-2xl font-bold text-t1">{checklist.readinessScore}%</p>
                  <p className="mt-1 text-xs text-t3">{checklist.readyCount}/{checklist.itemCount} checklist items complete</p>
                </div>
                <div className="rounded-2xl border border-[var(--b1)] bg-[linear-gradient(135deg,var(--s2),var(--s1))] p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-t3">Current tenant</p>
                  <p className="mt-1 text-sm font-semibold text-t1">{checklist.tenant?.name ?? 'Unknown'}</p>
                  <p className="mt-1 text-xs text-t3">{checklist.counts.patients} patients · {checklist.counts.appointments} appointments · {checklist.counts.policies} policies on file</p>
                </div>
              </div>
            )}
            {checklist && selectedTenantId && (
              <div className="mt-4 space-y-2">
                {checklist.items.map(item => (
                  <div key={item.key} className="flex items-start gap-3 rounded-2xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2.5">
                    {item.done
                      ? <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-v" aria-hidden="true" />
                      : <CircleDashed className="w-4 h-4 shrink-0 text-t3" aria-hidden="true" />}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-t1">{item.label} <span className="text-[11px] font-medium text-t3">— {item.done ? 'Complete' : 'Pending'}</span></p>
                      <p className="text-[11px] text-t3">{item.detail}</p>
                    </div>
                  </div>
                ))}
                <p className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-[11px] leading-5 text-t3">This checklist summarizes recorded setup tasks. It is not a security assessment, compliance certification, clinical validation, or launch authorization.</p>
              </div>
            )}
          </div>

          <div className="rounded-[2rem] border border-[var(--b1)] bg-[var(--s1)] p-5 shadow-sm">
            <button type="button" onClick={() => setCompanyOpen(v => !v)} className="flex w-full items-center justify-between gap-3 text-left">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Clinic onboarding</p>
                <h3 className="text-lg font-bold text-t1">Provision a new client company</h3>
              </div>
              {companyOpen ? <ChevronDown className="w-4 h-4 text-t3" /> : <ChevronRight className="w-4 h-4 text-t3" />}
            </button>
            {companyOpen && (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Company name</span>
                    <input value={companyName} onChange={e => { setCompanyName(e.target.value); if (!slugEdited) setCompanySlug(autoSlug(e.target.value)); }} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Sunrise Health Group" />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Slug</span>
                    <input value={companySlug} onChange={e => { setCompanySlug(autoSlug(e.target.value)); setSlugEdited(true); }} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="sunrise-health" />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Plan</span>
                    <select aria-label="Plan" value={planKey} onChange={e => setPlanKey(e.target.value)} disabled={!planOptions.length} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none">
                      {planOptions.length ? planOptions.map(p => <option key={p.key} value={p.key}>{p.name}</option>) : <option value="">Plan catalog unavailable</option>}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Default branch</span>
                    <input value={branchName} onChange={e => setBranchName(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Main Branch" />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Clinic timezone</span>
                    <input value={timezone} onChange={e => setTimezone(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="America/New_York" />
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Owner name</span>
                    <input value={ownerName} onChange={e => setOwnerName(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Dr. Jamie Lee" />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Owner email</span>
                    <input value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="owner@clinic.com" />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t3">Initial password</span>
                    <input type="password" autoComplete="new-password" value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Set an initial password" />
                  </label>
                </div>
                <button type="button" disabled={busy === 'create' || companyName.trim().length < 2 || companySlug.trim().length < 2 || ownerName.trim().length < 2 || ownerEmail.trim().length < 5 || ownerPassword.length < 8} onClick={() => void createTenant()} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                  {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserRoundPlus className="w-4 h-4" />} Create company
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-[2rem] border border-[var(--b1)] bg-[var(--s1)] p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Data import</p>
                <h3 className="text-lg font-bold text-t1">Upload or paste the client’s own CSV data</h3>
              </div>
              <div className="rounded-full border border-[var(--b1)] bg-[var(--s2)] p-1">
                {ENTITY_ORDER.map(key => (
                  <button key={key} type="button" onClick={() => { setEntityType(key); setPreview(null); setMapping({}); setImportResult(null); setShareResult(null); }} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${entityType === key ? 'bg-[var(--indigo)] text-white' : 'text-t2 hover:text-t1'}`}>
                    {ENTITY_LABELS[key]}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-t3">
              <span>{ENTITY_HELP[entityType]}</span>
              <button type="button" onClick={() => void downloadTemplate()} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1.25 font-semibold text-t2 hover:bg-[var(--bg)]">
                <Download className="w-3.5 h-3.5" /> Download template
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--b1)] bg-[linear-gradient(135deg,var(--s2),var(--s1))] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Mapping presets</p>
                  <h4 className="text-sm font-bold text-t1">Reuse the clinic’s saved column map</h4>
                </div>
                <button type="button" onClick={() => void savePreset()} disabled={!presetName.trim() || !selectedTenantId} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                  <Save className="w-4 h-4" /> Save preset
                </button>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-[1.2fr_0.8fr_0.5fr_auto]">
                <label className="block space-y-1">
                  <span className="text-[11px] font-semibold text-t3">Preset</span>
                  <select value={selectedPresetId} onChange={e => applyPreset(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--bg)] px-3 py-2 text-sm text-t1">
                    <option value="">No preset</option>
                    {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}{preset.isDefault ? ' (default)' : ''}</option>)}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-semibold text-t3">Preset name</span>
                  <input value={presetName} onChange={e => setPresetName(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--bg)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Main EHR mapping" />
                </label>
                <label className="flex items-center gap-2 pt-6 text-sm text-t2">
                  <input type="checkbox" checked={presetDefault} onChange={e => setPresetDefault(e.target.checked)} />
                  Default
                </label>
                <div className="flex items-end text-[11px] text-t3">The mapping below stays editable after you apply a preset.</div>
              </div>
              <p className="mt-2 text-[11px] text-t3">Pick a preset to auto-fill the mapping, then save a clinic-specific version when a customer uses a new export format.</p>
            </div>

            <label className="mt-4 block rounded-2xl border-2 border-dashed border-[var(--b1)] bg-[var(--s2)] p-4 hover:border-[var(--b2)]">
              <div className="flex items-center gap-3">
                <Upload className="w-5 h-5 text-indigo" />
                <div>
                  <p className="text-sm font-semibold text-t1">Drop a CSV or choose a file</p>
                  <p className="text-xs text-t3">We only need the raw file contents. The import stays operator-only and auditable.</p>
                </div>
              </div>
              <input
                type="file"
                accept=".csv,text/csv"
                className="mt-3 block w-full text-sm text-t2 file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--indigo)] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
                onChange={async e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  setCsvText(text);
                  setPreview(null);
                  setImportResult(null);
                }}
              />
            </label>

            <label className="mt-4 block space-y-1.5">
              <span className="text-[11px] font-semibold text-t3">Paste CSV text</span>
              <textarea value={csvText} onChange={e => { setCsvText(e.target.value); setPreview(null); setImportResult(null); }} rows={10} className="w-full rounded-2xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2.5 text-sm text-t1 outline-none" placeholder={entityType === 'patients' ? 'external_ref,first_name,last_name,email,phone\nPAT-1,Maya,Lopez,maya@example.com,555-1234' : 'Paste your CSV here'} />
            </label>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={busy === 'preview' || !csvText.trim() || !selectedTenantId} onClick={() => void previewImport()} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--bg)] disabled:opacity-40">
                {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Preview validation
              </button>
              <button type="button" disabled={!canImport || busy === 'commit'} onClick={() => void commitImport()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                {busy === 'commit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Commit import
              </button>
            </div>
          </div>

          {preview && (
            <div className="rounded-2xl border border-[var(--b1)] bg-[var(--bg)] p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Dry run</p>
                  <h3 className="text-lg font-bold text-t1">Validation preview</h3>
                </div>
                <span className={`badge ${preview.summary.invalid === 0 ? 'badge-emerald' : 'badge-amber'}`}>{preview.summary.valid}/{preview.summary.total} valid</span>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat label="Rows" value={preview.summary.total} />
                <MiniStat label="Valid" value={preview.summary.valid} />
                <MiniStat label="Warnings" value={preview.summary.warnings} />
                <MiniStat label="Invalid" value={preview.summary.invalid} />
              </div>

              <div className="space-y-3">
                {preview.fields.map(field => (
                  <div key={field.key} className="grid gap-2 sm:grid-cols-[1fr_1.4fr] sm:items-center">
                    <div>
                      <p className="text-sm font-semibold text-t1">{field.label} {field.required && <span className="text-[10px] text-red-v">required</span>}</p>
                      <p className="text-[11px] text-t3">{field.example ? `Example: ${field.example}` : 'No example available'}</p>
                    </div>
                    <select value={mapping[field.key] ?? field.mappedHeader ?? ''} onChange={e => setMapping(prev => ({ ...prev, [field.key]: e.target.value }))} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1">
                      <option value="">Do not map</option>
                      {preview.headers.map(header => <option key={header} value={header}>{header}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button type="button" disabled={busy === 'preview'} onClick={() => void previewImport()} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm font-semibold text-t2 hover:bg-[var(--bg)] disabled:opacity-40">
                  <RefreshCw className={`w-4 h-4 ${busy === 'preview' ? 'animate-spin' : ''}`} /> Re-run preview
                </button>
                {!preview.canCommit && <p className="text-xs text-amber-v">Fix the invalid rows before committing.</p>}
              </div>

              <div className="space-y-2">
                {preview.rows.map(row => (
                  <div key={row.index} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-t1">Row {row.index + 2}</p>
                      <span className={`badge ${row.status === 'error' ? 'badge-red' : row.status === 'warning' ? 'badge-amber' : 'badge-emerald'}`}>{row.status}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-t3">{csvSnippet(Object.entries(row.sample).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : String(v ?? '')}`).join(' | '))}</p>
                    {row.issues.length > 0 && <ul className="mt-2 space-y-1 text-[11px] text-red-v">{row.issues.map(issue => <li key={issue}>• {issue}</li>)}</ul>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-[var(--b1)] bg-[linear-gradient(135deg,var(--s2),var(--s1))] p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Customer handoff</p>
                  <h4 className="text-sm font-bold text-t1">Share the client-facing status link</h4>
                </div>
              <button type="button" onClick={() => void createShareLink()} disabled={!selectedTenantId} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                <Link2 className="w-4 h-4" /> Create link
              </button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[1.3fr_0.6fr]">
              <label className="block space-y-1">
                <span className="text-[11px] font-semibold text-t3">Link label</span>
                <input value={shareLabel} onChange={e => setShareLabel(e.target.value)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--bg)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Client status review" />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-semibold text-t3">Expires in days</span>
                <input type="number" min={1} max={90} value={shareDays} onChange={e => setShareDays(Number(e.target.value) || 14)} className="w-full rounded-xl border border-[var(--b1)] bg-[var(--bg)] px-3 py-2 text-sm text-t1 outline-none" />
              </label>
            </div>
            {shareResult && (
              <div className="mt-3 rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-3 shadow-sm">
                <p className="text-sm font-semibold text-t1">{shareResult.clinicName}</p>
                <p className="text-[11px] text-t3">Expires {new Date(shareResult.expiresAt).toLocaleDateString()} · {shareResult.label ?? 'untitled link'}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded-lg bg-[var(--s2)] px-2 py-1 text-[11px] text-t2 break-all">{shareResult.url}</code>
                  <button type="button" onClick={() => void copyShareUrl()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--bg)]">
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </button>
                </div>
              </div>
            )}
            {shares.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Issued links</p>
                {shares.map(share => (
                  <div key={share.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2">
                    <div>
                      <p className="text-sm font-semibold text-t1">{share.label ?? 'Untitled pilot status'}</p>
                      <p className="text-[11px] text-t3">{share.active ? `Active until ${new Date(share.expiresAt).toLocaleString()}` : 'Expired or revoked'}{share.lastViewedAt ? ` · last opened ${new Date(share.lastViewedAt).toLocaleString()}` : ' · not opened'}</p>
                    </div>
                    {share.active && <button type="button" disabled={busy === 'commit'} onClick={() => void revokeShareLink(share.id)} className="rounded-lg border border-red-v/30 px-2.5 py-1.5 text-[11px] font-semibold text-red-v hover:bg-red-v/5 disabled:opacity-40">Revoke link</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-t3">{label}</p>
      <p className="mt-1 text-lg font-bold text-t1">{value}</p>
    </div>
  );
}
