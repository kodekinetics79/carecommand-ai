import { Link } from 'react-router';
import { CircleCheck, CircleAlert, CircleX, CircleDashed, ExternalLink } from 'lucide-react';
import { failingChecks, type ReadinessCheck, type ReadinessResponse, type ReadinessStatus } from '../../lib/receptionistDeployment';

/**
 * A server-supplied fix link. In-app paths route through the SPA; anything
 * else (a provider console) opens in a new tab. Never invents a destination.
 */
export function FixLink({ href, label, className = '' }: { href: string | null; label: string; className?: string }) {
  if (!href) return null;
  const base = `inline-flex items-center gap-1 text-[11px] font-semibold text-indigo hover:underline ${className}`;
  if (/^https?:\/\//i.test(href)) {
    return <a href={href} target="_blank" rel="noreferrer" aria-label={label} className={base}>Fix <ExternalLink className="h-3 w-3" aria-hidden="true" /></a>;
  }
  return <Link to={href} aria-label={label} className={base}>Fix</Link>;
}

const ICON: Record<ReadinessStatus, { Icon: typeof CircleCheck; className: string; word: string }> = {
  pass: { Icon: CircleCheck, className: 'text-emerald-v', word: 'Passed' },
  warn: { Icon: CircleAlert, className: 'text-amber-v', word: 'Warning' },
  fail: { Icon: CircleX, className: 'text-red-v', word: 'Failed' },
  pending: { Icon: CircleDashed, className: 'text-t3', word: 'Not evaluated' },
};

export function ReadinessRow({ check }: { check: ReadinessCheck }) {
  const { Icon, className, word } = ICON[check.status] ?? ICON.pending;
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-status={check.status} data-check={check.key}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} aria-hidden="true" />
      <span className="sr-only">{word}:</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-t1">{check.label}</p>
        {check.detail && <p className="text-[11px] text-t3">{check.detail}</p>}
        {check.code && <p className="font-mono text-[10px] text-t3/80">{check.code}</p>}
      </div>
      <FixLink href={check.fixHref} label={`Fix ${check.label}`} />
    </li>
  );
}

/**
 * The readiness rows from `GET /campaigns/:id/readiness`. This is the only
 * activation gate (contract §6): the header pill and every row are the
 * server's evaluation, rendered verbatim, never recomputed on the client.
 */
export function ReadinessChecklist({ readiness }: { readiness: ReadinessResponse }) {
  const failing = failingChecks(readiness);
  const warnings = readiness.checks.filter(check => check.status === 'warn').length;
  const pill = readiness.ready
    ? { className: 'badge badge-emerald', text: warnings ? `Ready to activate · ${warnings} warning${warnings === 1 ? '' : 's'}` : 'Ready to activate' }
    : { className: 'badge badge-amber', text: `${failing.length} item${failing.length === 1 ? '' : 's'} to fix` };
  return (
    <section aria-label="Activation readiness" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Readiness</p>
        <span role="status" className={pill.className}>{pill.text}</span>
      </div>
      {readiness.checks.length === 0
        ? <p className="text-xs text-t3">The server returned no readiness checks for this campaign.</p>
        : <ul className="space-y-1.5">{readiness.checks.map(check => <ReadinessRow key={check.key} check={check} />)}</ul>}
      <p className="text-[10px] text-t3">Evaluated {new Date(readiness.evaluatedAt).toLocaleString()}</p>
    </section>
  );
}
