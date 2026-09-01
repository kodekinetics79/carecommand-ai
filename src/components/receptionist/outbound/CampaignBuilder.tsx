import { useEffect, useState } from 'react';
import { Save, Megaphone, Loader2 } from 'lucide-react';
import { Field, TextInput, TextArea, Select } from '../../ui/Field';
import { receptionistApi as api, OUTBOUND_REQUIRED_FIELDS, validateOutboundQuietHours, type Agent, type Campaign, type OutboundRequiredField, type OutboundBookingMode, type OutboundCampaignInput, type Location } from '../../../lib/receptionist';
import { isBusy, useMutationState } from '../../../hooks/useMutationState';
import { MutationNotice } from '../MutationNotice';
import { EMPTY_CAMPAIGN, toOutboundCampaignPayload } from './campaignPayload';

function RequiredFieldPicker({ value, onChange }: { value: OutboundRequiredField[]; onChange: (next: OutboundRequiredField[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {OUTBOUND_REQUIRED_FIELDS.map(f => {
        const on = value.includes(f.key);
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(on ? value.filter(k => k !== f.key) : [...value, f.key])}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${on ? 'border-indigo bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-[var(--s3)] text-t3'}`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function CampaignFormFields({ form, set, bookingAuthorities, locations, agents, effectiveAgentId }: { form: OutboundCampaignInput; set: (patch: Partial<OutboundCampaignInput>) => void; bookingAuthorities: Campaign[]; locations: Location[]; agents: Agent[]; effectiveAgentId: string | null }) {
  return (
    <>
      <Field label="Campaign name" required>
        <TextInput value={form.name} onChange={e => set({ name: e.target.value })} placeholder="June reactivation outreach" />
      </Field>
      {form.bookingMode !== 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' && (
        <Field
          label="Which receptionist places these calls?"
          required
          hint={agents.length === 0
            ? 'No published receptionist on this clinic yet. Publish one on the Go live tab first — a campaign cannot be approved without it.'
            : 'The published receptionist whose voice and prompt this campaign uses.'}
        >
          <Select
            aria-label="Receptionist placing these calls"
            value={effectiveAgentId ?? ''}
            onChange={e => set({ agentId: e.target.value || null })}
          >
            <option value="">{agents.length === 0 ? 'No published receptionist available' : 'Select a receptionist'}</option>
            {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Call script" required hint="What the agent should say. Keep it scheduling-focused — the AI must not give medical advice.">
        <TextArea rows={4} disabled={form.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'} value={form.script} onChange={e => set({ script: e.target.value })} placeholder="Hi, this is {{agent_name}} calling from {{clinic_name}}..." />
      </Field>
      <Field label="Required fields to collect" hint="The agent will route to staff review if any of these are missing.">
        {form.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'
          ? <p className="text-xs text-t3">Controlled by the linked attested booking campaign.</p>
          : <RequiredFieldPicker value={form.requiredFields ?? []} onChange={v => set({ requiredFields: v })} />}
      </Field>
      <Field label="Campaign consent / disclaimer text" hint="Paste clinic- and counsel-approved jurisdictional wording. A saved script is not proof of consent.">
        <TextArea rows={2} value={form.consentText ?? ''} onChange={e => set({ consentText: e.target.value })} placeholder="Approved campaign-specific disclosure" />
      </Field>
      <Field label="Human handoff instruction" hint="When the agent should transfer to a human.">
        <TextInput value={form.humanHandoffInstruction ?? ''} onChange={e => set({ humanHandoffInstruction: e.target.value })} placeholder="Transfer if the caller asks clinical questions." />
      </Field>
      <Field label="Booking mode" required hint="Direct booking only books when a branch, a valid time, and a free slot are all available; otherwise it routes to staff review.">
        <Select aria-label="Booking mode" value={form.bookingMode} onChange={e => set({ bookingMode: e.target.value as OutboundBookingMode })}>
          <option value="APPOINTMENT_REQUEST_ONLY">Appointment request only (staff books)</option>
          <option value="DIRECT_BOOKING_IF_SLOT_AVAILABLE">Direct booking if a slot is available</option>
        </Select>
      </Field>
      {form.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' && (
        <Field label="Attested booking campaign ID" required hint="Direct booking uses this active Receptionist Campaign as the sole prompt, intake, service, location, and tool authority.">
          <Select aria-label="Attested booking campaign" value={form.receptionistCampaignId ?? ''} onChange={e => {
            const authority = bookingAuthorities.find(c => c.id === e.target.value);
            const eligibleLocation = locations.find(location => authority?.eligibleLocationIds.includes(location.id) && location.active && location.branchId);
            set({
              receptionistCampaignId: e.target.value || null,
              agentId: authority?.agentId ?? null,
              defaultService: authority?.appointmentType ?? null,
              defaultBranchId: eligibleLocation?.branchId ?? null,
              script: authority?.offerScript ?? form.script,
            });
          }}>
            <option value="">Select active attested campaign</option>
            {bookingAuthorities.map(authority => <option key={authority.id} value={authority.id}>{authority.name} — {authority.appointmentType}</option>)}
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Field label="Call purpose" required>
          <Select aria-label="Call purpose" value={form.purpose ?? ''} onChange={e => set({ purpose: e.target.value as OutboundCampaignInput['purpose'] })}>
            <option value="CARE_COORDINATION">Care coordination</option>
            <option value="APPOINTMENT_REMINDER">Appointment reminder</option>
            <option value="PATIENT_REACTIVATION">Patient reactivation</option>
          </Select>
        </Field>
        <Field label="Legal basis" required>
          <Select aria-label="Legal basis" value={form.legalBasis ?? ''} onChange={e => set({ legalBasis: e.target.value as OutboundCampaignInput['legalBasis'] })}>
            <option value="TREATMENT_OPERATIONS">Treatment / operations</option>
            <option value="EXPLICIT_CONSENT">Explicit consent</option>
          </Select>
        </Field>
        <Field label="Policy version" required hint="Approved outbound policy identifier.">
          <TextInput value={form.policyVersion ?? ''} onChange={e => set({ policyVersion: e.target.value })} placeholder="OUTBOUND-2026-01" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default branch ID" hint="Required for direct booking.">
          {form.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' ? (
            <Select aria-label="Eligible booking branch" value={form.defaultBranchId ?? ''} onChange={e => set({ defaultBranchId: e.target.value || null })}>
              <option value="">Select eligible mapped branch</option>
              {locations.filter(location => {
                const authority = bookingAuthorities.find(c => c.id === form.receptionistCampaignId);
                return authority?.eligibleLocationIds.includes(location.id) && location.active && location.branchId;
              }).map(location => <option key={location.id} value={location.branchId!}>{location.name}</option>)}
            </Select>
          ) : <TextInput value={form.defaultBranchId ?? ''} onChange={e => set({ defaultBranchId: e.target.value })} placeholder="branch uuid (optional)" />}
        </Field>
        <Field label="Default service">
          <TextInput disabled={form.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'} value={form.defaultService ?? ''} onChange={e => set({ defaultService: e.target.value })} placeholder="Consultation" />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Quiet hours start"><TextInput value={form.quietHoursStart ?? ''} onChange={e => set({ quietHoursStart: e.target.value })} placeholder="21:00" /></Field>
        <Field label="Quiet hours end"><TextInput value={form.quietHoursEnd ?? ''} onChange={e => set({ quietHoursEnd: e.target.value })} placeholder="08:00" /></Field>
        <Field label="Max retries"><TextInput type="number" min={0} max={10} value={form.maxRetryAttempts ?? 1} onChange={e => set({ maxRetryAttempts: Number(e.target.value) })} /></Field>
      </div>
    </>
  );
}

export function CampaignBuilder({ clinicId, bookingAuthorities, locations, timezone, onSaved, onCancel }: { clinicId: string; bookingAuthorities: Campaign[]; locations: Location[]; timezone: string; onSaved: (id: string) => void; onCancel: () => void }) {
  const [form, setForm] = useState<OutboundCampaignInput>({ ...EMPTY_CAMPAIGN, clinicId });
  // The voice agent that will place these calls.
  //
  // This form never collected one, so every campaign it created was born with
  // agentId null — and `approveOutboundAuthority` refuses that with
  // `agent_unlinked`. A campaign could be created, could not be approved, and
  // could not be edited afterwards, so the only way out was a database write.
  // Three clinics' worth of that was a demo lost.
  //
  // Direct booking is exempt: there the agent is inherited from the attested
  // booking authority below, and choosing one here would let the two disagree.
  const [agents, setAgents] = useState<Agent[] | null>(null);
  useEffect(() => {
    let active = true;
    void api.listAgents(clinicId)
      .then(rows => { if (active) setAgents(rows); })
      .catch(() => { if (active) setAgents([]); });
    return () => { active = false; };
  }, [clinicId]);

  const usableAgents = (agents ?? []).filter(agent => agent.active && agent.providerAgentId);
  // One agent is the overwhelmingly common case, so it is chosen rather than
  // asked about — a required question with exactly one possible answer is not a
  // choice, it is a step to forget. DERIVED, not written into form state: a
  // default that lives in state has to be kept in sync with the list it came
  // from, and this one is simply recomputed.
  const effectiveAgentId = form.agentId ?? (usableAgents.length === 1 ? usableAgents[0].id : null);
  const saveState = useMutationState();
  const saving = isBusy(saveState.state);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<OutboundCampaignInput>) => setForm(prev => ({ ...prev, ...patch }));

  async function save() {
    const quietHoursError = validateOutboundQuietHours(form.quietHoursStart, form.quietHoursEnd, timezone);
    if (quietHoursError) { setErr(quietHoursError); return; }
    // Saving a campaign that can never be approved is worse than refusing it:
    // there is no edit form, so an unlinked campaign is unusable forever and
    // the only remedy is a database write. Say so here instead.
    if (form.bookingMode !== 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' && !effectiveAgentId) {
      setErr(usableAgents.length === 0
        ? 'This clinic has no published receptionist yet, so a campaign cannot be approved. Publish one on the Go live tab first.'
        : 'Choose which receptionist places these calls.');
      return;
    }
    setErr(null);
    const row = await saveState.run(() => api.createOutboundCampaign(toOutboundCampaignPayload({ ...form, agentId: effectiveAgentId }, clinicId)));
    if (row) onSaved(row.id);
  }

  return (
    <div className="cc-card p-5 space-y-4">
      <h3 className="text-sm font-bold text-t1 flex items-center gap-2"><Megaphone className="w-4 h-4 text-indigo" /> New outbound campaign</h3>
      <CampaignFormFields form={form} set={set} bookingAuthorities={bookingAuthorities} locations={locations} agents={usableAgents} effectiveAgentId={effectiveAgentId} />
      <p className="text-[11px] text-t3">Quiet hours are enforced in clinic timezone {timezone}. Overnight windows such as 21:00–08:00 are supported.</p>
      {err && <p role="alert" className="text-xs text-red-v">{err}</p>}
      <MutationNotice state={saveState.state} showSaved={false} />
      <div className="flex gap-2">
        <button type="button" disabled={saving || !form.name || !form.script} onClick={save} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Create campaign
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)]">Cancel</button>
      </div>
    </div>
  );
}
