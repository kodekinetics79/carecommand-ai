import { ShieldCheck, ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import PageHeader from './PageHeader';

// The single state shown when someone arrives — by deep link, bookmark, or a
// stale tab — at a section their role does not cover. It is deliberately not an
// error: nothing failed, the section simply is not part of this account's work.
// It names what they are looking at and who can change it, and never surfaces a
// status code, the word "forbidden", or a raw permission key.
export default function AccessRestricted({ section, role, workspace }: {
  section: string;
  role?: string;
  workspace?: string;
}) {
  const roleLabel = role ? role.toLowerCase().replace(/_/g, ' ') : null;
  const place = workspace ? ` at ${workspace}` : '';

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title={section}
        subtitle="This section is limited to the roles that work in it."
      />
      <div className="cc-card">
        <div className="bento-body flex flex-col items-start gap-4 sm:flex-row sm:items-start">
          <div className="w-11 h-11 shrink-0 rounded-2xl bg-[var(--indigo-soft)] grid place-items-center text-indigo">
            <ShieldCheck className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-bold text-t1">{section} is not part of your access</p>
            <p className="text-[12px] leading-relaxed text-t2 max-w-xl">
              {roleLabel
                ? <>You are signed in as <span className="font-semibold capitalize text-t1">{roleLabel}</span>{place}. That role does not cover {section}, so it is kept out of your navigation.</>
                : <>Your account does not cover {section}, so it is kept out of your navigation.</>}
            </p>
            <p className="text-[12px] leading-relaxed text-t3 max-w-xl">
              If your work needs it, ask an owner or administrator{place} to update your role. Nothing is missing from your account and nothing went wrong here.
            </p>
            <Link to="/" className="inline-flex items-center gap-1.5 pt-1 text-[12px] font-semibold text-indigo hover:underline">
              Back to Command Center <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
