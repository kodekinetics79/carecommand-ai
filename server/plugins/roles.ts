import type { FastifyRequest } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';

export function requireRoles(...roles: UserRole[]) {
  return async (request: FastifyRequest) => {
    if (!roles.includes(request.auth.role)) {
      throw request.server.httpErrors.forbidden('Your role cannot perform this action');
    }
  };
}
