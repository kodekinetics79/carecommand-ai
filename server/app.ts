import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env';
import { authPlugin } from './plugins/auth';
import { errorPlugin } from './plugins/errors';
import { healthRoutes } from './modules/health/routes';
import { authRoutes } from './modules/auth/routes';
import { branchRoutes } from './modules/branches/routes';
import { providerRoutes } from './modules/providers/routes';
import { staffRoutes } from './modules/staff/routes';
import { patientRoutes } from './modules/patients/routes';
import { appointmentRoutes } from './modules/appointments/routes';
import { autopilotRoutes } from './modules/autopilot/routes';
import { operationsRoutes } from './modules/operations/routes';
import { dashboardRoutes } from './modules/dashboard/routes';
import { telehealthRoutes } from './modules/telehealth/routes';
import { complianceRoutes } from './modules/compliance/routes';
import { settingsRoutes } from './modules/settings/routes';

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
    requestIdHeader: 'x-request-id',
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map(origin => origin.trim()),
    credentials: true,
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: { title: 'CareCommand API', version: '0.1.0' },
      tags: [
        { name: 'health', description: 'Service health' },
        { name: 'patients', description: 'Customer360 records' },
        { name: 'appointments', description: 'Scheduling records' },
        { name: 'providers', description: 'Provider productivity and utilization' },
        { name: 'staff', description: 'Staff workflow and SLA management' },
        { name: 'autopilot', description: 'Governed AI workflow actions' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  await app.register(errorPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/v1/auth' });

  await app.register(async protectedApi => {
    protectedApi.addHook('preHandler', protectedApi.authenticate);
    await protectedApi.register(branchRoutes, { prefix: '/branches' });
    await protectedApi.register(providerRoutes, { prefix: '/providers' });
    await protectedApi.register(staffRoutes, { prefix: '/staff' });
    await protectedApi.register(patientRoutes, { prefix: '/patients' });
    await protectedApi.register(appointmentRoutes, { prefix: '/appointments' });
    await protectedApi.register(autopilotRoutes, { prefix: '/autopilot' });
    await protectedApi.register(telehealthRoutes, { prefix: '/telehealth' });
    await protectedApi.register(complianceRoutes, { prefix: '/compliance' });
    await protectedApi.register(settingsRoutes, { prefix: '/settings' });
    await protectedApi.register(operationsRoutes);
    await protectedApi.register(dashboardRoutes);
  }, { prefix: '/v1' });

  return app;
}
