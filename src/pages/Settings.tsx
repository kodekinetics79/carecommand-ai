import { Settings2, Users, MapPin, Bell, Lock, Palette, Globe, ChevronRight, CheckCircle2, Star } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import { branches, doctors } from '../data/mockClinics';

const roles = [
  { role: 'Owner', desc: 'Full access to all modules, billing, and settings.', users: 1, color: 'bg-violet-100 text-violet-700' },
  { role: 'Branch Manager', desc: 'Access to branch-level data, staff, and inventory.', users: 3, color: 'bg-blue-100 text-blue-700' },
  { role: 'Provider', desc: 'Own schedule, patient notes, and follow-up tools.', users: 8, color: 'bg-emerald-100 text-emerald-700' },
  { role: 'Front Desk', desc: 'Scheduling, CRM, and inbound communication.', users: 6, color: 'bg-amber-100 text-amber-700' },
];

const notificationTemplates = [
  { name: 'Appointment reminder (24h)', channel: 'WhatsApp + SMS', status: 'active' },
  { name: 'Post-visit review request', channel: 'WhatsApp', status: 'active' },
  { name: 'Missed call follow-up', channel: 'SMS', status: 'active' },
  { name: 'Reactivation campaign (90d inactive)', channel: 'WhatsApp + Email', status: 'active' },
  { name: 'Winback offer (180d inactive)', channel: 'Email', status: 'paused' },
];

export default function Settings() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Settings"
        subtitle="Practice configuration, roles, branding, notification templates, and security controls."
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition shadow-md shadow-blue-500/20">
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
          <button key={item.label} type="button" className="flex items-center gap-2 p-3 rounded-xl border border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50 transition-all text-xs font-semibold text-slate-700">
            <span className="text-slate-500">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Branches */}
        <BentoCard title="Practice Locations" subtitle="Branch configuration" headerRight={<MapPin className="w-4 h-4 text-slate-400" />}>
          <div className="space-y-2.5">
            {branches.map((branch) => (
              <div key={branch.id} className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 transition-all group">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                    {branch.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-900 group-hover:text-blue-700 transition-colors">{branch.name}</p>
                    <p className="text-[11px] text-slate-400">{branch.location}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">{branch.patientCount} customers</span>
                  <ChevronRight className="w-3 h-3 text-slate-300" />
                </div>
              </div>
            ))}
          </div>
        </BentoCard>

        {/* Provider directory */}
        <BentoCard title="Provider Directory" subtitle="All active providers" headerRight={<Star className="w-4 h-4 text-slate-400" />}>
          <div className="space-y-2.5">
            {doctors.map((doctor) => {
              const branch = branches.find(b => b.id === doctor.branchId);
              return (
                <div key={doctor.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 transition-all group">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[9px] font-bold shrink-0">
                      {doctor.name.split(' ').slice(-1)[0][0]}
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-900 group-hover:text-blue-700 transition-colors">{doctor.name}</p>
                      <p className="text-[10px] text-slate-400">{doctor.specialty} · {branch?.name.split(' ')[0]}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span className="text-[10px] font-bold text-slate-700">{doctor.rating}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Notification templates */}
        <BentoCard title="Notification Templates" subtitle="Automated message configuration" headerRight={<Bell className="w-4 h-4 text-slate-400" />}>
          <div className="space-y-2.5">
            {notificationTemplates.map((t) => (
              <div key={t.name} className={`flex items-center justify-between gap-3 p-3.5 rounded-xl border transition-all ${t.status === 'paused' ? 'border-slate-200 bg-slate-50/50' : 'border-slate-200 hover:border-blue-200'}`}>
                <div>
                  <p className="text-xs font-bold text-slate-900">{t.name}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">Channel: {t.channel}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${t.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{t.status}</span>
                  <button type="button" className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 transition-colors">Edit</button>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="mt-3 w-full py-2 border border-dashed border-slate-200 rounded-xl text-xs font-semibold text-slate-500 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-all">
            + Add template
          </button>
        </BentoCard>

        <div className="space-y-4">
          {/* Role-based access */}
          <BentoCard title="Role-Based Access" subtitle="User permissions" headerRight={<Lock className="w-4 h-4 text-slate-400" />}>
            <div className="space-y-2.5">
              {roles.map((r) => (
                <div key={r.role} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${r.color}`}>{r.role}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-slate-600">{r.desc}</p>
                  </div>
                  <span className="text-[10px] text-slate-400 shrink-0">{r.users} users</span>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Branding & Security */}
          <div className="grid gap-3">
            <div className="p-4 rounded-2xl border border-slate-200 hover:border-violet-200 hover:bg-violet-50/20 transition-all cursor-pointer">
              <div className="flex items-center gap-2 mb-1">
                <Palette className="w-4 h-4 text-violet-500" />
                <p className="text-xs font-bold text-slate-900">Branding</p>
              </div>
              <p className="text-[11px] text-slate-500">Logo, primary colour, website widget appearance and email footer design.</p>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-violet-600">Edit branding <ChevronRight className="w-3 h-3" /></button>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 hover:border-blue-200 hover:bg-blue-50/20 transition-all cursor-pointer">
              <div className="flex items-center gap-2 mb-1">
                <Globe className="w-4 h-4 text-blue-500" />
                <p className="text-xs font-bold text-slate-900">Booking Widget</p>
              </div>
              <p className="text-[11px] text-slate-500">Self-booking widget embed code for your practice website.</p>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600">Get embed code <ChevronRight className="w-3 h-3" /></button>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 hover:border-red-200 hover:bg-red-50/20 transition-all cursor-pointer">
              <div className="flex items-center gap-2 mb-1">
                <Lock className="w-4 h-4 text-red-500" />
                <p className="text-xs font-bold text-slate-900">Security</p>
              </div>
              <p className="text-[11px] text-slate-500">Two-factor authentication, session management, and IP allow-listing.</p>
              <button type="button" className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-red-600">Security settings <ChevronRight className="w-3 h-3" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
