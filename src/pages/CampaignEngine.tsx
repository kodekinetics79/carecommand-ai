import { Navigate, useLocation } from 'react-router';

/**
 * Redirect for the two paths the campaign workspace used to live behind.
 *
 * `/campaigner` was the planner on the thin `/v1/campaigns` CRUD and
 * `/reactivation` was the governed engine on `/v1/crm/campaigns`. They were one
 * object — the same `Campaign` table — presented through two field families,
 * and the door most users walked through was attached to the half that could
 * not dispatch. They are now a single destination at `/campaigns`.
 *
 * Both old paths stay resolvable so bookmarks, shared links, saved deep links
 * and any caller that still names them keep working, and the navigation payload
 * travels with the redirect: a "create a campaign" CTA that sent a goal must not
 * lose it just because the URL it aimed at moved. Replace, not push, so the
 * retired path does not sit in the history between the user and Back.
 */
export default function LegacyCampaignRedirect() {
  const location = useLocation();
  return <Navigate to="/campaigns" replace state={location.state} />;
}
