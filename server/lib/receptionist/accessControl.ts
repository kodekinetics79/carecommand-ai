import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit';
import { getRequestPermissions, type Permission } from '../permissions';

/**
 * Receptionist-specific authorization intents. These intentionally map onto the
 * existing tenant-customisable permission catalogue so they can be enforced
 * without a schema change or a second, conflicting role system.
 */
export const RECEPTIONIST_PERMISSIONS = {
  CALL_ARTIFACTS_READ: 'receptionist:call-artifacts:read',
  RECORDINGS_READ: 'receptionist:recordings:read',
  MANAGE: 'receptionist:manage',
} as const;

export type ReceptionistPermission = Extract<
  Permission,
  typeof RECEPTIONIST_PERMISSIONS[keyof typeof RECEPTIONIST_PERMISSIONS]
>;

export async function hasReceptionistPermission(
  request: FastifyRequest,
  permission: ReceptionistPermission,
): Promise<boolean> {
  const granted = await getRequestPermissions(request);
  return granted.has(permission);
}

/**
 * API guard with a receptionist-specific denial contract. A denied attempt is
 * written to the tenant audit trail without request bodies, phone numbers,
 * transcript text, recording URLs, or any other PHI.
 */
export function requireReceptionistPermission(permission: ReceptionistPermission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (await hasReceptionistPermission(request, permission)) return;

    await audit(request, {
      action: 'receptionist.access.denied',
      resource: 'receptionistAccess',
      metadata: {
        permission,
        method: request.method,
        route: request.routeOptions.url,
      },
    }).catch(error => {
      request.log.error({ err: error }, 'Failed to persist receptionist access-denied audit event');
    });

    return reply.code(403).send({
      error: 'insufficient_permission',
      permission,
      message: `Your role does not have the required permission (${permission}) for this action.`,
    });
  };
}
