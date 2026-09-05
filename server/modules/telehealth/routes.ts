import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { requirePermission } from '../../lib/permissions';
import { branchScope } from '../../lib/scope';
import { clinicLocalMinuteToUtc } from '../../lib/scheduling';
import { cursorPage } from '../../lib/pagination';

const sessionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
  page: z.literal('true').optional(),
  branchId: z.string().uuid().optional(),
  // Without a window this returned the OLDEST video visits in the tenant's
  // whole history while the screen was labelled "Today".
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export function clinicTodayRange(timezone: string, now = new Date()): { from: Date; to: Date } {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const nextDate = new Date(`${date}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const from = clinicLocalMinuteToUtc(date, 0, timezone);
  const to = clinicLocalMinuteToUtc(nextDate.toISOString().slice(0, 10), 0, timezone);
  if (!from || !to) throw new Error(`Invalid clinic timezone: ${timezone}`);
  return { from, to };
}

export const telehealthRoutes: FastifyPluginAsync = async app => {
  // Virtual visits are appointments booked on the VIDEO channel.
  app.get('/sessions', { preHandler: requirePermission('appointment:read') }, async request => {
    const query = sessionQuery.parse(request.query);
    const selectedBranchId = request.auth.branchId ?? query.branchId;
    const branches = await db.branch.findMany({
      where: { tenantId: request.auth.tenantId, active: true, ...(selectedBranchId ? { id: selectedBranchId } : {}) },
      select: { id: true, timezone: true },
    });
    const defaultTodayScope = query.from || query.to
      ? undefined
      : branches.map(branch => {
          const range = clinicTodayRange(branch.timezone);
          return { branchId: branch.id, startsAt: { gte: range.from, lt: range.to } };
        });
    const rows = await db.appointment.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        branchId: selectedBranchId,
        channel: 'VIDEO',
        deletedAt: null,
        ...(defaultTodayScope
          ? { OR: defaultTodayScope }
          : { startsAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } }),
      },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      include: {
        patient: { select: { firstName: true, lastName: true } },
        branch: { select: { name: true, timezone: true } },
        providerProfile: { select: { id: true, user: { select: { displayName: true } } } },
      },
    });

    // Real intake state. This previously asserted intakeComplete from the
    // APPOINTMENT status alone, so a clinician saw a green "Intake complete"
    // badge for a patient who had submitted nothing. PatientIntakePacket is
    // keyed by appointmentId, so the true state is available.
    const page = cursorPage(rows, query.limit);
    const packets = page.data.length
      ? await db.patientIntakePacket.findMany({
        where: { tenantId: request.auth.tenantId, appointmentId: { in: page.data.map(row => row.id) } },
        select: { appointmentId: true, status: true },
      })
      : [];
    const intakeByAppointment = new Map(packets.map(packet => [packet.appointmentId, packet.status]));

    const data = page.data.map(row => ({
      id: row.id,
      patientName: `${row.patient.firstName} ${row.patient.lastName}`,
      service: row.service,
      startsAt: row.startsAt.toISOString(),
      status: row.status,
      providerProfileId: row.providerProfileId,
      provider: row.providerProfile?.user.displayName ?? 'Provider not resolved',
      branchName: row.branch.name,
      branchTimezone: row.branch.timezone,
      value: row.value.toString(),
      noShowRisk: row.noShowRisk,
      // Truthful: derived from the patient's actual intake packet, not from the
      // appointment status. `not_started` means no packet exists for this visit.
      intakeStatus: intakeByAppointment.get(row.id) ?? 'not_started',
      intakeComplete: intakeByAppointment.get(row.id) === 'approved',
    }));
    return query.page === 'true' || query.cursor ? { ...page, data } : data;
  });
};
