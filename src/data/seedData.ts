export { branches, doctors } from './mockClinics';
export { patients, leads } from './mockPatients';
export { campaigns } from './mockCampaigns';
export { appointments } from './mockAppointments';
export { inventoryItems } from './mockInventory';
export { radarAlerts } from './mockRadar';
export { revenueData, branchRevenue, serviceRevenue } from './mockRevenue';
export { reviews } from './mockReviews';
export { labOrders } from './mockLabs';
export { integrations } from './mockIntegrations';
export { staffMembers } from './mockStaff';

export const auditLogs = [
  { id: 'audit-1', event: 'Patient consent recorded', user: 'Front Desk', date: '26 May 2026, 09:10', type: 'consent' },
  { id: 'audit-2', event: 'Campaign launched', user: 'Marketing Lead', date: '26 May 2026, 10:05', type: 'change' },
  { id: 'audit-3', event: 'Review response sent', user: 'Operations', date: '26 May 2026, 11:40', type: 'approval' },
  { id: 'audit-4', event: 'Inventory reorder submitted', user: 'Branch Manager', date: '26 May 2026, 12:20', type: 'change' },
  { id: 'audit-5', event: 'AI guardrail updated', user: 'Admin', date: '26 May 2026, 13:05', type: 'change' },
] as const;
