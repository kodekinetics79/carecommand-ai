import { Clock } from 'lucide-react';

/**
 * Placeholder slot for C2's `AfterHoursCard` (phase2-contracts §12: C2 ships
 * the card as an exported component + jsdom test; C4 mounts it on the Front
 * Desk page). C2's frontend is built concurrently, so the card does not exist
 * at this branch head. The merge step replaces this component with
 * `import { AfterHoursCard } from './AfterHoursCard'` in FrontDesk.tsx and
 * deletes this file. Until then the page states, truthfully, that no
 * after-hours figure is computed here.
 */
export function AfterHoursSlot({ clinicName }: { clinicName: string | null }) {
  return (
    <section aria-label="After-hours activity" className="cc-card p-4">
      <p className="bento-sub">After-hours</p>
      <h3 className="bento-title">After-hours activity</h3>
      <div className="mt-3 rounded-xl border border-dashed border-[var(--b2)] bg-[var(--s3)] p-4 text-center">
        <Clock className="mx-auto mb-2 h-5 w-5 text-t3" aria-hidden="true" />
        <p className="text-xs font-semibold text-t2">No after-hours metric is calculated yet{clinicName ? ` for ${clinicName}` : ''}.</p>
        <p className="mt-1 text-[11px] text-t3">Opening hours and the after-hours card arrive with the knowledge, hours and locale cycle; browser-local time is not used as a substitute.</p>
      </div>
    </section>
  );
}
