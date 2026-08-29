import { apiRequest } from './api';

// ===========================================================================
// Service catalog.
//
// The API has had full CRUD here since the module was written and no screen has
// ever called it, so ServiceCatalogItem is empty in every workspace and services
// are free text a receptionist types. Two consequences, and the second is a trap:
//
//  1. Duration comes from the request rather than clinic policy, and two
//     spellings of one service are two services.
//  2. resolveSchedulingService is fail-closed on a CONFIGURED catalog — with any
//     active item present, a booking whose service does not match one exactly is
//     refused with "Select an active service". So the first service a clinic ever
//     creates silently breaks every other booking until the rest are entered.
//     Without a screen, they could not see the list, let alone finish it.
// ===========================================================================

export interface ServiceCatalogItem {
  id: string;
  name: string;
  category: string;
  defaultDurationMinutes: number;
  defaultAppointmentValue: number | null;
  depositRuleId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceCatalogInput {
  name: string;
  category?: string;
  defaultDurationMinutes?: number;
  defaultAppointmentValue?: number | null;
  active?: boolean;
}

const base = '/v1/services';

export const servicesApi = {
  list: () => apiRequest<ServiceCatalogItem[]>(base),
  create: (input: ServiceCatalogInput) =>
    apiRequest<ServiceCatalogItem>(base, { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: Partial<ServiceCatalogInput>) =>
    apiRequest<ServiceCatalogItem>(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
};

/**
 * Whether the catalog governs booking.
 *
 * Mirrors resolveSchedulingService: the server switches to strict matching as
 * soon as ONE active item exists. The booking form has to follow the same rule,
 * or it offers a free-text box for a value the server will reject.
 */
export function catalogGovernsBooking(items: ServiceCatalogItem[]): boolean {
  return items.some(item => item.active);
}

export function activeServices(items: ServiceCatalogItem[]): ServiceCatalogItem[] {
  return items.filter(item => item.active);
}

/** Minutes rendered the way a front desk reads them. */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
