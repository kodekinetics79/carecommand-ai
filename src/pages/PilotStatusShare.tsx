import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleDashed, Clock3, Loader2, ShieldCheck } from 'lucide-react';
import { useParams } from 'react-router';
import { platformAdmin, type PilotChecklistView } from '../lib/platformAdmin';

type ShareView = {
  link: { label: string | null; expiresAt: string; active: boolean };
  clinic: { id: string; name: string; slug: string };
  checklist: PilotChecklistView;
};

export default function PilotStatusShare() {
  const { token = '' } = useParams();
  const [view, setView] = useState<ShareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await platformAdmin.getPilotStatusShare(token);
        if (!active) return;
        setView(data);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'This pilot link is unavailable.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(99,102,241,0.16),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(14,165,233,0.12),_transparent_28%),linear-gradient(180deg,var(--bg),var(--s2))] px-4 py-8 sm:px-6 sm:py-12">
        <div className="pointer-events-none absolute left-4 top-10 h-40 w-40 rounded-full bg-[rgba(99,102,241,0.10)] blur-3xl" />
        <div className="pointer-events-none absolute bottom-10 right-0 h-56 w-56 rounded-full bg-[rgba(14,165,233,0.10)] blur-3xl" />
        <div role="status" aria-live="polite" className="relative mx-auto flex max-w-4xl items-center justify-center rounded-[2rem] border border-[var(--b1)] bg-white/80 p-10 shadow-[0_22px_70px_rgba(15,23,42,0.10)] backdrop-blur">
          <Loader2 className="mr-3 h-5 w-5 animate-spin text-[var(--indigo)]" />
          <span className="text-sm font-semibold text-t2">Loading pilot status…</span>
        </div>
      </div>
    );
  }

  if (error || !view) {
    return (
      <div className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(99,102,241,0.16),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(14,165,233,0.12),_transparent_28%),linear-gradient(180deg,var(--bg),var(--s2))] px-4 py-8 sm:px-6 sm:py-12">
        <div className="pointer-events-none absolute left-4 top-10 h-40 w-40 rounded-full bg-[rgba(99,102,241,0.10)] blur-3xl" />
        <div className="pointer-events-none absolute bottom-10 right-0 h-56 w-56 rounded-full bg-[rgba(14,165,233,0.10)] blur-3xl" />
        <div className="relative mx-auto max-w-3xl rounded-[2rem] border border-[var(--b1)] bg-white/85 p-10 shadow-[0_22px_70px_rgba(15,23,42,0.10)] backdrop-blur">
          <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-t3">Status link</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-t1">This link is unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-t2">{error ?? 'The pilot status link could not be found.'}</p>
        </div>
      </div>
    );
  }

  const { checklist } = view;
  return (
    <div className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(99,102,241,0.16),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(14,165,233,0.12),_transparent_28%),linear-gradient(180deg,var(--bg),var(--s2))] px-4 py-8 sm:px-6 sm:py-10">
      <div className="pointer-events-none absolute left-4 top-10 h-40 w-40 rounded-full bg-[rgba(99,102,241,0.10)] blur-3xl" />
      <div className="pointer-events-none absolute bottom-10 right-0 h-56 w-56 rounded-full bg-[rgba(14,165,233,0.10)] blur-3xl" />
      <div className="relative mx-auto max-w-5xl space-y-6">
        <section className="overflow-hidden rounded-[2rem] border border-[var(--b1)] bg-white/85 shadow-[0_24px_70px_rgba(15,23,42,0.12)] backdrop-blur">
          <div className="h-1 bg-[linear-gradient(90deg,var(--indigo),rgba(37,99,235,0.65),rgba(8,145,178,0.75))]" />
          <div className="p-8 sm:p-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-t3">Customer status</p>
                <h1 className="mt-2 text-4xl font-black tracking-tight text-t1">{view.clinic.name}</h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-t2">
                  This shared view summarizes pilot setup records and checklist completion. It is not a security assessment, compliance certification, or authorization to launch.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] bg-[linear-gradient(135deg,var(--s2),var(--s1))] px-4 py-3 text-right shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-t3">Checklist completion</p>
                <p className="mt-1 text-3xl font-black text-t1">{checklist.readinessScore}%</p>
                <p className="text-xs text-t3">{checklist.readyCount}/{checklist.itemCount} complete</p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <StatCard label="Clinic" value={view.clinic.name} />
              <StatCard label="Link status" value={view.link.active ? 'Active' : 'Expired'} />
              <StatCard label="Expires" value={new Date(view.link.expiresAt).toLocaleDateString()} />
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <InfoCard title="Pilot setup checklist" subtitle="Recorded completion state for each setup item">
            <div className="space-y-2">
              {checklist.items.map(item => (
                <div key={item.key} className="flex items-start gap-3 rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-3">
                  {item.done
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-v" aria-hidden="true" />
                    : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-amber-v" aria-hidden="true" />}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-t1">{item.label} <span className={`ml-1 text-[10px] uppercase tracking-wide ${item.done ? 'text-emerald-v' : 'text-amber-v'}`}>{item.done ? 'Complete' : 'Pending'}</span></p>
                    <p className="text-xs text-t3">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </InfoCard>

          <InfoCard title="Setup facts" subtitle="Operational context for authorized pilot stakeholders">
            <div className="space-y-3 text-sm text-t2">
              <div className="flex items-center gap-2 rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-3">
                <ShieldCheck className="h-4 w-4 text-[var(--indigo)]" />
                <span>This view is designed for summary setup data. Do not place patient information in share labels or notes.</span>
              </div>
              <div className="flex items-center gap-2 rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-3">
                <Clock3 className="h-4 w-4 text-[var(--indigo)]" />
                <span>Valid until {new Date(view.link.expiresAt).toLocaleDateString()}</span>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-t3">Share label</p>
                <p className="mt-1 font-medium text-t1">{view.link.label ?? 'Pilot status'}</p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-t3">Imported record counts</p>
                <p className="mt-1 font-medium text-t1">{checklist.counts.patients} patients, {checklist.counts.appointments} appointments, {checklist.counts.policies} policies on file</p>
                <p className="mt-1 text-xs text-t3">These operational counts are confidential and do not prove data quality or workflow readiness.</p>
              </div>
            </div>
          </InfoCard>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-3 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-t3">{label}</p>
      <p className="mt-1 text-sm font-semibold text-t1">{value}</p>
    </div>
  );
}

function InfoCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="rounded-[2rem] border border-[var(--b1)] bg-white/85 p-6 shadow-[0_18px_55px_rgba(15,23,42,0.08)] backdrop-blur">
      <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-t3">{subtitle}</p>
      <h2 className="mt-1 text-xl font-black tracking-tight text-t1">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}
