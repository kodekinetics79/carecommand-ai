import { Link } from 'react-router';
import { Clock, Loader2, MoonStar } from 'lucide-react';
import { HOURS_STATUS_PATH, blockerLabel, type HoursStatusClinic, type HoursStatusView } from '../../lib/receptionistClinic';
import { useResource } from '../../hooks/useResource';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { LoadFailureNotice } from './MutationNotice';

export const STUDIO_CLINIC_HREF = '/receptionist-studio?tab=clinic';

/**
 * Per-clinic open/closed status and after-hours inbound call counts, from the
 * hours engine. Loading shows no numbers, an error shows the failure sentence,
 * and a clinic with no hours configured gets the honest empty state with a link
 * to the Clinic Profile tab — never a zero that reads as "no after-hours calls".
 * Exported for C4's Front Desk page to mount.
 */
export function AfterHoursCard({ studioHref = STUDIO_CLINIC_HREF }: { studioHref?: string }) {
  const resource = useResource<HoursStatusView>(HOURS_STATUS_PATH);
  const failure = resourceFailure(resource.state);
  const view = receivedData(resource.state);

  return (
    <section className="cc-card p-5 space-y-3" aria-labelledby="after-hours-card-title">
      <div className="flex items-center justify-between">
        <h3 id="after-hours-card-title" className="text-sm font-bold text-t1 inline-flex items-center gap-2"><MoonStar className="w-4 h-4 text-indigo" aria-hidden="true" /> After-hours activity</h3>
        {view && <span className="text-[10px] text-t3">as of {new Date(view.at).toLocaleTimeString()}</span>}
      </div>
      {resource.state.status === 'loading' && (
        <p className="inline-flex items-center gap-2 text-xs text-t3" aria-live="polite"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading hours status…</p>
      )}
      {failure && <LoadFailureNotice what="Hours status" message={failure.message} onRetry={resource.reload} />}
      {view && view.clinics.length === 0 && (
        <p className="text-xs text-t3">No clinics configured yet. <Link to={studioHref} className="text-indigo underline">Create one in the Studio</Link>.</p>
      )}
      {view && view.clinics.map(clinic => <ClinicHoursRow key={clinic.clinicId} clinic={clinic} studioHref={studioHref} />)}
    </section>
  );
}

function ClinicHoursRow({ clinic, studioHref }: { clinic: HoursStatusClinic; studioHref: string }) {
  if (!clinic.configured) {
    return (
      <div className="rounded-xl border border-dashed border-amber-v/50 px-3 py-2.5" data-testid={`after-hours-${clinic.clinicId}`}>
        <p className="text-sm font-semibold text-t1">{clinic.name}</p>
        <p className="text-xs text-amber-v">Opening hours are not configured, so after-hours calls cannot be counted and the agent cannot say when you reopen.</p>
        {clinic.blockers.length > 0 && <p className="text-[10px] text-t3">{clinic.blockers.map(blockerLabel).join(' · ')}</p>}
        <Link to={studioHref} className="mt-1 inline-block text-xs font-semibold text-indigo underline">Set hours in the Clinic Profile tab</Link>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[var(--b1)] px-3 py-2.5 space-y-1" data-testid={`after-hours-${clinic.clinicId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-t1">{clinic.name}</p>
        {clinic.isOpenNow
          ? <span className="badge badge-emerald">Open now</span>
          : <span className="badge badge-amber">Closed{clinic.nextOpening?.spoken ? ` — reopens ${clinic.nextOpening.spoken}` : ''}</span>}
      </div>
      {clinic.closureReason && <p className="text-xs text-t2">Closure: {clinic.closureReason}</p>}
      <p className="text-xs text-t2 inline-flex items-center gap-1"><Clock className="w-3 h-3" aria-hidden="true" /> Today: {clinic.todayHoursSpoken}</p>
      <p className="text-xs text-t2">After-hours calls: <strong className="text-t1">{clinic.afterHoursCalls.last24Hours}</strong> in 24h · <strong className="text-t1">{clinic.afterHoursCalls.last7Days}</strong> in 7 days</p>
      {clinic.formatFallback && <p className="text-[10px] text-amber-v">Locale pack not approved — times shown in the fallback format.</p>}
    </div>
  );
}
