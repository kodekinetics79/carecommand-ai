import { useState } from 'react';
import { Settings2, Users, MapPin, Bell, Lock, Palette, Globe, ChevronRight, CheckCircle2, Star, Trash2, Plus } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import { branches as mockBranches, doctors as mockDoctors } from '../data/mockClinics';
import { useApiResource } from '../hooks/useApiResource';
import { useCrudResource } from '../hooks/useCrudResource';
import { mapProviderProfile, type ApiProviderProfile } from '../lib/apiAdapters';
import type { Doctor } from '../types';

interface ApiBranchRow {
  id: string;
  name: string;
  location: string;
  _count?: { patients: number } | null;
}

interface BranchRow {
  id: string;
  name: string;
  location: string;
  patientCount: number;
}

const fallbackBranches: BranchRow[] = mockBranches.map(branch => ({
  id: branch.id,
  name: branch.name,
  location: branch.location,
  patientCount: branch.patientCount,
}));

function mapBranchRow(row: ApiBranchRow): BranchRow {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    patientCount: row._count?.patients ?? 0,
  };
}

interface ApiRole {
  id: string;
  name: string;
  description: string;
  accent: string;
  userCount: number;
}

interface ApiTemplate {
  id: string;
  name: string;
  channel: string;
  status: 'ACTIVE' | 'PAUSED';
}

const accentBadge: Record<string, string> = {
  violet: 'badge badge-violet',
  blue: 'badge badge-blue',
  emerald: 'badge badge-emerald',
  amber: 'badge badge-amber',
  red: 'badge badge-red',
};

const fallbackRoles: ApiRole[] = [
  { id: 'r1', name: 'Owner', description: 'Full access to all modules, billing, and settings.', accent: 'violet', userCount: 1 },
  { id: 'r2', name: 'Branch Manager', description: 'Access to branch-level data, staff, and inventory.', accent: 'blue', userCount: 3 },
  { id: 'r3', name: 'Provider', description: 'Own schedule, patient notes, and follow-up tools.', accent: 'emerald', userCount: 8 },
  { id: 'r4', name: 'Front Desk', description: 'Scheduling, CRM, and inbound communication.', accent: 'amber', userCount: 6 },
];

const fallbackTemplates: ApiTemplate[] = [
  { id: 't1', name: 'Appointment reminder (24h)', channel: 'WhatsApp + SMS', status: 'ACTIVE' },
  { id: 't2', name: 'Post-visit review request', channel: 'WhatsApp', status: 'ACTIVE' },
  { id: 't3', name: 'Missed call follow-up', channel: 'SMS', status: 'ACTIVE' },
  { id: 't4', name: 'Reactivation campaign (90d inactive)', channel: 'WhatsApp + Email', status: 'ACTIVE' },
  { id: 't5', name: 'Winback offer (180d inactive)', channel: 'Email', status: 'PAUSED' },
];

export default function Settings() {
  const { data: branches } = useApiResource<ApiBranchRow, BranchRow>('/v1/branches?limit=100', fallbackBranches, mapBranchRow);
  const { data: doctors } = useApiResource<ApiProviderProfile, Doctor>('/v1/providers/overview?limit=100', mockDoctors, mapProviderProfile);
  const templates = useCrudResource<ApiTemplate>('/v1/settings/notification-templates', fallbackTemplates);
  const roles = useCrudResource<ApiRole>('/v1/settings/roles', fallbackRoles);

  const [newTemplate, setNewTemplate] = useState({ name: '', channel: '' });
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', description: '' });
  const [showRoleForm, setShowRoleForm] = useState(false);

  async function addTemplate() {
    if (!newTemplate.name.trim() || !newTemplate.channel.trim()) return;
    await templates.create({ name: newTemplate.name.trim(), channel: newTemplate.channel.trim(), status: 'ACTIVE' });
    setNewTemplate({ name: '', channel: '' });
    setShowTemplateForm(false);
  }

  async function addRole() {
    if (!newRole.name.trim() || !newRole.description.trim()) return;
    await roles.create({ name: newRole.name.trim(), description: newRole.description.trim(), accent: 'blue' });
    setNewRole({ name: '', description: '' });
    setShowRoleForm(false);
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Settings"
        subtitle="Practice configuration, roles, branding, notification templates, and security controls."
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition">
            <CheckCircle2 className="w-4 h-4" /> Save Changes
          </button>
        }
      />

      {/* Quick settings nav */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Branches', icon: <MapPin className="w-4 h-4" /> },
          { label: 'Providers', icon: <Users className="w-4 h-4" /> },
          { label: 'Roles', icon: <Lock className="w-4 h-4" /> },
          { label: 'Notifications', icon: <Bell className="w-4 h-4" /> },
          { label: 'Branding', icon: <Palette className="w-4 h-4" /> },
          { label: 'Security', icon: <Settings2 className="w-4 h-4" /> },
        ].map((item) => (
          <button key={item.label} type="button" className="flex items-center gap-2 p-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all text-xs font-semibold text-t2">
            <span className="text-t3">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Branches */}
        <BentoCard title="Practice Locations" subtitle="Branch configuration" headerRight={<MapPin className="w-4 h-4 text-t3" />}>
          <div className="space-y-2.5">
            {branches.map((branch) => (
              <div key={branch.id} className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all group">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                    {branch.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-t1 group-hover:text-indigo transition-colors">{branch.name}</p>
                    <p className="text-[11px] text-t3">{branch.location}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-t3">{branch.patientCount} customers</span>
                  <ChevronRight className="w-3 h-3 text-t3" />
                </div>
              </div>
            ))}
          </div>
        </BentoCard>

        {/* Provider directory */}
        <BentoCard title="Provider Directory" subtitle="All active providers" headerRight={<Star className="w-4 h-4 text-t3" />}>
          <div className="space-y-2.5">
            {doctors.map((doctor) => {
              const branch = branches.find(b => b.id === doctor.branchId);
              return (
                <div key={doctor.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all group">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[9px] font-bold shrink-0">
                      {doctor.name.split(' ').slice(-1)[0][0]}
                    </div>
                    <div>
                      <p className="text-xs font-bold text-t1 group-hover:text-indigo transition-colors">{doctor.name}</p>
                      <p className="text-[10px] text-t3">{doctor.specialty} · {branch?.name.split(' ')[0]}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span className="text-[10px] font-bold text-t2">{doctor.rating}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Notification templates */}
        <BentoCard title="Notification Templates" subtitle="Automated message configuration" headerRight={<Bell className="w-4 h-4 text-t3" />}>
          {templates.error && <p className="text-[11px] text-red-v mb-2">{templates.error}</p>}
          <div className="space-y-2.5">
            {templates.data.map((t) => (
              <div key={t.id} className={`flex items-center justify-between gap-3 p-3.5 rounded-xl border transition-all ${t.status === 'PAUSED' ? 'border-[var(--b1)] bg-[var(--s2)]' : 'border-[var(--b1)] hover:border-[var(--b2)]'}`}>
                <div>
                  <p className="text-xs font-bold text-t1">{t.name}</p>
                  <p className="text-[10px] text-t3 mt-0.5">Channel: {t.channel}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${t.status === 'ACTIVE' ? 'badge badge-emerald' : 'badge badge-blue'}`}>{t.status.toLowerCase()}</span>
                  <button type="button" disabled={templates.busy} onClick={() => templates.update(t.id, { status: t.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} className="text-[10px] font-semibold text-indigo hover:text-blue-v transition-colors disabled:opacity-40">
                    {t.status === 'ACTIVE' ? 'Pause' : 'Activate'}
                  </button>
                  <button type="button" disabled={templates.busy} onClick={() => templates.remove(t.id)} className="text-t3 hover:text-red-v transition-colors disabled:opacity-40" aria-label="Delete template">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {showTemplateForm ? (
            <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
              <input value={newTemplate.name} onChange={e => setNewTemplate(v => ({ ...v, name: e.target.value }))} placeholder="Template name" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <input value={newTemplate.channel} onChange={e => setNewTemplate(v => ({ ...v, channel: e.target.value }))} placeholder="Channel (e.g. WhatsApp + SMS)" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <div className="flex gap-2">
                <button type="button" disabled={templates.busy} onClick={addTemplate} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:bg-[var(--indigo-mid)] transition disabled:opacity-40">Add</button>
                <button type="button" onClick={() => setShowTemplateForm(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)] transition">Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setShowTemplateForm(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:border-[var(--b3)] hover:text-indigo hover:bg-[var(--s3)] transition-all inline-flex items-center justify-center gap-1">
              <Plus className="w-3.5 h-3.5" /> Add template
            </button>
          )}
        </BentoCard>

        <div className="space-y-4">
          {/* Role-based access */}
          <BentoCard title="Role-Based Access" subtitle="User permissions" headerRight={<Lock className="w-4 h-4 text-t3" />}>
            {roles.error && <p className="text-[11px] text-red-v mb-2">{roles.error}</p>}
            <div className="space-y-2.5">
              {roles.data.map((r) => (
                <div key={r.id} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors group">
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${accentBadge[r.accent] ?? 'badge badge-blue'}`}>{r.name}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-t2">{r.description}</p>
                  </div>
                  <span className="text-[10px] text-t3 shrink-0">{r.userCount} users</span>
                  <button type="button" disabled={roles.busy} onClick={() => roles.remove(r.id)} className="text-t3 hover:text-red-v transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-40 shrink-0" aria-label="Delete role">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            {showRoleForm ? (
              <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
                <input value={newRole.name} onChange={e => setNewRole(v => ({ ...v, name: e.target.value }))} placeholder="Role name" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                <input value={newRole.description} onChange={e => setNewRole(v => ({ ...v, description: e.target.value }))} placeholder="Description" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                <div className="flex gap-2">
                  <button type="button" disabled={roles.busy} onClick={addRole} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:bg-[var(--indigo-mid)] transition disabled:opacity-40">Add</button>
                  <button type="button" onClick={() => setShowRoleForm(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)] transition">Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowRoleForm(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:border-[var(--b3)] hover:text-indigo hover:bg-[var(--s3)] transition-all inline-flex items-center justify-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add role
              </button>
            )}
          </BentoCard>

          {/* Branding & Security */}
          <div className="grid gap-3">
            <div className="p-4 rounded-2xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--violet-soft)] transition-all cursor-pointer">
              <div className="flex items-center gap-2 mb-1">
                <Palette className="w-4 h-4 text-violet-v" />
                <p className="text-xs font-bold text-t1">Branding</p>
              </div>
              <p className="text-[11px] text-t3">Logo, primary colour, website widget appearance and email footer design.</p>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-violet-v">Edit branding <ChevronRight className="w-3 h-3" /></button>
            </div>
            <div className="p-4 rounded-2xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--blue-soft)] transition-all cursor-pointer">
              <div className="flex items-center gap-2 mb-1">
                <Globe className="w-4 h-4 text-blue-v" />
                <p className="text-xs font-bold text-t1">Booking Widget</p>
              </div>
              <p className="text-[11px] text-t3">Self-booking widget embed code for your practice website.</p>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo">Get embed code <ChevronRight className="w-3 h-3" /></button>
            </div>
            <div className="p-4 rounded-2xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--red-soft)] transition-all cursor-pointer">
              <div className="flex items-center gap-2 mb-1">
                <Lock className="w-4 h-4 text-red-v" />
                <p className="text-xs font-bold text-t1">Security</p>
              </div>
              <p className="text-[11px] text-t3">Two-factor authentication, session management, and IP allow-listing.</p>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-red-v">Security settings <ChevronRight className="w-3 h-3" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
