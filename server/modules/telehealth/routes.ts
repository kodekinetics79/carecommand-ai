import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { requirePermission } from '../../lib/permissions';
import { branchScope } from '../../lib/scope';

const sessionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  branchId: z.string().uuid().optional(),
  // Without a window this returned the OLDEST video visits in the tenant's
  // whole history while the screen was labelled "Today".
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export const telehealthRoutes: FastifyPluginAsync = async app => {
  // Virtual visits are appointments booked on the VIDEO channel.
  app.get('/sessions', { preHandler: requirePermission('appointment:read') }, async request => {
    const query = sessionQuery.parse(request.query);
    const rows = await db.appointment.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
        channel: 'VIDEO',
        deletedAt: null,
        startsAt: { gte: query.from ?? startOfToday(), ...(query.to ? { lte: query.to } : {}) },
      },
      orderBy: { startsAt: 'asc' },
      take: query.limit,
      include: {
        patient: { select: { firstName: true, lastName: true } },
        branch: { select: { name: true } },
      },
    });

    // Real intake state. This previously asserted intakeComplete from the
    // APPOINTMENT status alone, so a clinician saw a green "Intake complete"
    // badge for a patient who had submitted nothing. PatientIntakePacket is
    // keyed by appointmentId, so the true state is available.
    const packets = rows.length
      ? await db.patientIntakePacket.findMany({
        where: { tenantId: request.auth.tenantId, appointmentId: { in: rows.map(row => row.id) } },
        select: { appointmentId: true, status: true },
      })
      : [];
    const intakeByAppointment = new Map(packets.map(packet => [packet.appointmentId, packet.status]));

    return rows.map(row => ({
      id: row.id,
      patientName: `${row.patient.firstName} ${row.patient.lastName}`,
      service: row.service,
      startsAt: row.startsAt.toISOString(),
      status: row.status,
      provider: row.providerRef ?? 'Assigned provider',
      branchName: row.branch.name,
      value: row.value.toString(),
      noShowRisk: row.noShowRisk,
      // Truthful: derived from the patient's actual intake packet, not from the
      // appointment status. `not_started` means no packet exists for this visit.
      intakeStatus: intakeByAppointment.get(row.id) ?? 'not_started',
      intakeComplete: intakeByAppointment.get(row.id) === 'approved',
    }));
  });
};
