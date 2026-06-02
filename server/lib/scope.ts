import type { FastifyRequest } from 'fastify';

export function branchScope(request: FastifyRequest) {
  return request.auth.branchId ? { branchId: request.auth.branchId } : {};
}

export function assertBranchAccess(request: FastifyRequest, branchId: string) {
  if (request.auth.branchId && request.auth.branchId !== branchId) {
    throw request.server.httpErrors.forbidden('Your account is restricted to another branch');
  }
}
