import type { Prisma } from '../../generated/prisma/client';

/**
 * In-app delivery for clinical safety alerts.
 *
 * The problem this closes: every monitoring alert created a NotificationEvent
 * row with `status: 'queued'` and nothing anywhere ever moved it. The only
 * drainer in the codebase filters on the appointment-confirmation source and an
 * appointmentId, so it could never match one of these. There was also no route
 * that returned them. A 400 mg/dL glucose reading therefore produced an alert, a
 * notification row, and silence — the assigned nurse was told nothing and would
 * only find it by happening to open the monitoring page. The integration suite
 * even asserted `status: 'queued', sentAt: null` as the expected end state,
 * which pinned non-delivery as correct behaviour.
 *
 * What "delivered" honestly means here. There is no external provider for an
 * in-app channel — the app IS the channel — so delivery is the moment the row
 * reaches the recipient's inbox, and acknowledgement is the moment a human says
 * they have seen it. Those are two different facts and the model already has a
 * field for each, so both are recorded rather than collapsed into one.
 *
 * Rows carry an explicit source so they are identifiable, and so they can never
 * be picked up by the appointment outbox, whose retry and provider-submission
 * semantics do not apply to them.
 */
export const MONITORING_ALERT_SOURCE = 'monitoring.clinical_alert';

/** Statuses that still represent something the recipient has not seen. */
export const UNSEEN_NOTIFICATION_STATUSES = ['queued', 'sent'] as const;

/**
 * Who may see a given notification.
 *
 * Addressed rows go to their recipient. Rows that could not be addressed — no
 * accountable staff member was resolvable when the alert fired — must not
 * vanish, because an alert nobody owns is exactly the one most likely to be
 * missed. They are visible to everyone who can already read the monitoring
 * surface, which is role- and entitlement-gated upstream.
 */
export function inboxScope(actorUserId: string): Prisma.NotificationEventWhereInput {
  return {
    channel: 'in_app',
    source: MONITORING_ALERT_SOURCE,
    OR: [
      { recipientUserId: actorUserId },
      { recipientUserId: null },
    ],
  };
}
