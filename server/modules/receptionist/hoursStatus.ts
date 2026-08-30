import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { hoursConfigured, hoursStatus, isOpenAt, todayHoursSpoken } from '../../lib/receptionist/clinicHours';
import { bundleHoursConfigured, loadHoursSource } from '../../lib/receptionist/hoursSource';
import { resolveApprovedLocalePack, resolvedLocaleFormat } from '../../lib/receptionist/localePacks/resolve';
import { receptionistRead } from './shared';

// ===========================================================================
// Live open/closed state per clinic for the Front Desk after-hours card and
// the Studio badges. Everything here is derived: when hours are not
// configured the response says so rather than reporting "closed".
// ===========================================================================

export const hoursStatusRoutes: FastifyPluginAsync = async app => {
  app.get('/hours-status', { preHandler: receptionistRead }, async request => {
    const query = z.object({ at: z.string().datetime().optional(), clinicId: z.string().uuid().optional() }).parse(request.query);
    const at = query.at ? new Date(query.at) : new Date();
    const tenantId = request.auth.tenantId;
    const clinics = await db.receptionistClinic.findMany({
      where: { tenantId, active: true, ...(query.clinicId ? { id: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, timezone: true, country: true, defaultLanguage: true },
    });
    const since24h = new Date(at.getTime() - 86_400_000);
    const since7d = new Date(at.getTime() - 7 * 86_400_000);

    const rows = await Promise.all(clinics.map(async clinic => {
      const bundle = await loadHoursSource(db, { tenantId, clinicId: clinic.id, now: at });
      const pack = clinic.country ? await resolveApprovedLocalePack(db, { tenantId, language: clinic.defaultLanguage, country: clinic.country }) : null;
      const locale = resolvedLocaleFormat(pack, clinic.defaultLanguage);
      const configured = bundle ? bundleHoursConfigured(bundle) : false;
      const status = bundle ? hoursStatus(bundle.source, at, locale) : null;
      const [last24Hours, last7Days, lastCall] = await Promise.all([
        db.receptionistCallLog.count({ where: { tenantId, clinicId: clinic.id, direction: 'inbound', outsideHours: true, startedAt: { gte: since24h } } }),
        db.receptionistCallLog.count({ where: { tenantId, clinicId: clinic.id, direction: 'inbound', outsideHours: true, startedAt: { gte: since7d } } }),
        db.receptionistCallLog.findFirst({
          where: { tenantId, clinicId: clinic.id, direction: 'inbound', outsideHours: true },
          orderBy: { startedAt: 'desc' }, select: { startedAt: true },
        }),
      ]);
      return {
        clinicId: clinic.id,
        name: clinic.name,
        timezone: clinic.timezone,
        country: clinic.country,
        configured,
        blockers: configured ? [] : ['clinic_hours_missing'],
        // `formatFallback` tells the UI these times are formatted with a
        // default, because no approved pack decides 12h/24h for this clinic.
        formatFallback: pack === null,
        isOpenNow: status?.isOpenNow ?? false,
        today: status?.today ?? null,
        todayHoursSpoken: status?.todayHoursSpoken ?? 'hours not configured',
        nextOpening: status?.nextOpening ? { ...status.nextOpening, spoken: status.nextOpeningSpoken } : null,
        closureReason: status?.closureReason ?? null,
        afterHoursCalls: { last24Hours, last7Days, lastAt: lastCall?.startedAt?.toISOString() ?? null },
        locations: (bundle?.locations ?? []).filter(location => location.active).map(location => {
          const locationConfigured = hoursConfigured(location.source);
          const day = isOpenAt(location.source, at);
          return {
            id: location.id,
            name: location.name,
            timezone: location.timezone,
            configured: locationConfigured,
            isOpenNow: locationConfigured && day.open,
            todayHoursSpoken: todayHoursSpoken(day.day, locale),
          };
        }),
      };
    }));
    return { at: at.toISOString(), clinics: rows };
  });
};
